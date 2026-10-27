# Doctor login + research submission flow

Access control and research-submission integrity for the precision-oncology
platform launching at **biometricscreeningresearch.net**. This module is the
gate that keeps unverified accounts — "randoms" — from touching research
data, while giving verified doctors a safe way to contribute submissions
that only become part of the live dataset after human review.

Built on top of the front-end work in PR #2 (merged to `main`). It
is deliberately self-contained: plain Node.js (CommonJS, matching the repo),
`node:crypto` only, no new dependencies.

## The flow

```
Admin ──issues invite──▶ Doctor registers (invite required)
                              │  NPI + state license collected
                              │  NPI checked: Luhn locally, then NPPES registry
                              │  account status = pending
                              ▼
                         Doctor enrolls MFA (TOTP authenticator)
                              │  confirms with a live code
                              ▼
                         Admin approves ──▶ account status = active
                              │
                              ▼
                         Login = password + TOTP ──▶ signed session token
                              │
                              ▼
                         Doctor submits research ──▶ status = pending_review
                              │
                              ▼
                         Reviewer approves ──▶ live dataset
                         Reviewer rejects (note required) ──▶ returned
```

There is **no public sign-up path**. The only way an account comes into
existence is `UserService.register()`, and it refuses to run without a
valid invite.

## Security decisions

- **Invites** are 32 random bytes; only their SHA-256 hash is stored. They
  are single-use and expire (default 72h, `INVITE_TTL_HOURS`). An invite may
  optionally be bound to one email address and one role.
- **Credential verification.** Registrants supply an NPI and a state license
  number/state. The NPI is validated locally (10 digits, CMS Luhn check over
  the `80840` prefix) and then looked up in the public NPPES registry API
  (`npiregistry.cms.hhs.gov`), confirming the number exists, belongs to an
  active individual provider, and the registered name roughly matches. A
  format failure, registry miss, or name mismatch blocks registration. Any
  network/registry failure degrades the account to `manual_review` — a
  human decides — it **never** auto-approves.
- **Passwords** are hashed with scrypt (N=16384, r=8, p=1) and a per-user
  random salt; minimum length 12.
- **MFA is mandatory before activation.** TOTP (RFC 6238, implemented on
  `node:crypto`) enrollment alone is not enough: the user must confirm with
  a live code, and an admin cannot approve an account that has not
  confirmed. Login requires password + TOTP, and each TOTP step may be
  used for exactly one login (replay protection via last-used counter).
- **Sessions** are HMAC-SHA256-signed, expiring tokens designed for an
  `httpOnly`, `SameSite=Lax` cookie (`sessionCookie()`), and are recorded
  server-side so they can be revoked (logout, suspension).
- **Roles.** `doctor` submits and manages only their own submissions;
  `reviewer` approves/rejects; `admin` issues invites and approves or
  suspends accounts (and inherits reviewer rights). Reviewers and admins
  cannot review their own submissions.
- **Data integrity.** Submissions always land as `pending_review` — there is
  no API path that creates or edits a record directly into the live
  dataset. Editing an already-reviewed submission returns it to
  `pending_review`. Edits never overwrite: each edit bumps `version` and
  archives the previous content in `history`. Deletes are soft
  (`deletedAt`/`deletedBy`); records are retained. Every mutation —
  registration, approval, suspension, login, submission create/edit/review/
  delete — appends to an **append-only audit log** (the `AuditLog` class
  exposes no update or delete operation).

## Modules

| File | Responsibility |
| --- | --- |
| `index.js` | `createAuthService()` facade wiring everything together; `login()` / `logout()` convenience flow |
| `store.js` | Pluggable store interface + `MemoryStore` and `JsonFileStore` implementations |
| `invites.js` | Admin-issued invite tokens (hashed at rest, single-use, expiring) |
| `users.js` | Registration, password hashing, MFA enrollment/confirmation, admin approval/suspension, credential checks |
| `npi.js` | NPI format/Luhn validation and NPPES registry lookup |
| `totp.js` | RFC 4226/6238 HOTP/TOTP, base32 secrets, `otpauth://` URIs |
| `session.js` | Signed expiring session tokens, cookie helpers, request resolvers/middleware |
| `roles.js` | Role constants, guard helpers, Express-style `authenticate`/`authorize` factories |
| `submissions.js` | Submission lifecycle, review queue, versioning, soft deletes, `AuditLog` |

## Data model

All records live behind the store interface in five collections. The
prototype persists them to one JSON file; the same interface maps onto
Azure Cosmos containers (one per collection, partition key `/id`) when the
platform hardens.

- **users** — `id, name, email, passwordHash, npi, licenseNumber,
  licenseState, role, status (pending|active|suspended), npiVerification
  (verified|manual_review), totpSecret, mfaConfirmedAt, approvedBy,
  approvedAt, createdAt, updatedAt`
- **invites** — `id, tokenHash, email?, role, createdBy, createdAt,
  expiresAt, usedAt, usedByUserId`
- **submissions** — `id, submittedBy, title, summary, biomarkers,
  cancerType, sourceUrl, status (pending_review|approved|rejected),
  version, history[], reviewNote, reviewedBy, reviewedAt, deletedAt,
  deletedBy, createdAt, updatedAt`
- **audit** — `id, at, actorId, actorRole, action, entityType, entityId,
  details` (append-only)
- **sessions** — `id, userId, createdAt, expiresAt, revokedAt`

## Configuration

| Environment variable | Purpose | Default |
| --- | --- | --- |
| `SESSION_SECRET` | HMAC key for session tokens (≥16 chars) | Random per-boot secret + warning when unset (sessions do not survive restarts) |
| `INVITE_TTL_HOURS` | Invite lifetime | `72` |
| `AUTH_STORE_FILE` | JSON store location | `data/auth-store.json` (git-ignored by the repo's `data/*.json` rule) |
| `AUTH_ISSUER` | Name shown in authenticator apps | `Biometric Screening Research` |
| `SESSION_COOKIE_NAME` | Session cookie name | `bsr_session` |

## Mounted into `server.js`

The service layer is wired into the running server through a thin HTTP
adapter in `server.js` (the app is built by an exported `createApp(authService)`
factory, which is also how the integration tests inject a service backed
by a temporary store). All rules stay in this module; the routes only
translate HTTP ↔ service calls. `AuthError`s are mapped by the server's
error middleware to `{ error, code }` JSON with the error's HTTP status.

| Route | Who | What it does |
| --- | --- | --- |
| `POST /api/auth/invites` | admin | Create an invite; returns the raw token **once**, plus a `registrationPath` |
| `GET /api/auth/invites` | admin | List invites (hashes never leave the store) |
| `POST /api/auth/register` | invite holder | Register (invite token required; role comes from the invite, never from the request body) |
| `POST /api/auth/mfa/enroll` | pending account (email + password) | Begin TOTP enrollment; returns the secret + `otpauth://` URI |
| `POST /api/auth/mfa/confirm` | pending account (email + password) | Confirm enrollment with a live TOTP code |
| `POST /api/auth/login` | active/pending account | Password + TOTP → session token in an httpOnly `Set-Cookie` |
| `POST /api/auth/logout` | signed-in user | Revoke the current session and clear the cookie |
| `GET /api/auth/me` | signed-in user | Current account (public view — no hash/secret) |
| `GET /api/auth/users` | admin | List accounts (public view) |
| `POST /api/auth/users/:id/approve` | admin | Activate an account (refused until MFA is confirmed) |
| `POST /api/auth/users/:id/suspend` | admin | Suspend an account |
| `POST /api/submissions` | doctor/admin | Create a submission — always lands as `pending_review` |
| `GET /api/submissions` | doctor/admin | List my submissions |
| `GET /api/submissions/:id` | owner / reviewer / admin | Fetch one submission |
| `PATCH /api/submissions/:id` | owner / admin | Edit (versions; re-enters review if it was approved) |
| `DELETE /api/submissions/:id` | owner / admin | Soft-delete |
| `GET /api/review-queue` | reviewer/admin | List submissions awaiting review |
| `POST /api/review-queue/:id/approve` | reviewer/admin | Approve into the live dataset |
| `POST /api/review-queue/:id/reject` | reviewer/admin | Reject (a note is required) |

MFA enrollment is identified by email + password rather than a session
cookie because login itself requires a confirmed TOTP code — a pending
account cannot hold a session yet. Credential endpoints (`register`,
`login`, `mfa/*`) are rate-limited (50 attempts / 15 min per IP) via the
repo's `express-rate-limit`, alongside `helmet` and the global
`Cache-Control: no-store`.

`SESSION_SECRET` behavior: when set to at least 16 characters it keys the
session HMAC. When missing or too short, `server.js` generates a random
per-boot secret and logs a warning instead of refusing to start; every
restart then invalidates all sessions. Set it for any real deployment.

Integration tests for the adapter live in `server.auth.test.js` (repo
root): they boot the app on an ephemeral port with a temp-file store and
a stubbed NPPES lookup and drive the full journey over HTTP, plus the
negative cases (401 unauthenticated, 403 for a doctor on the review
queue, wrong-TOTP and wrong-password logins, registration without an
invite, rejection without a note).

## Prototype limits (honest list)

- **Invite delivery is manual.** There is no email service wired up: an
  admin creates an invite and shares the registration link with the doctor
  out of band. (`createInvite` returns the raw token exactly once.)
- **The JSON file store is single-instance only** and rewrites the whole
  dataset per write. Swap in Cosmos before any real deployment.
- **The state license is collected but not yet verified** against state
  board databases; today it is reviewed by the approving admin together
  with the NPI result.
- **No password reset / account recovery flow yet** — an admin suspends
  and re-invites.
- **Not HIPAA-compliant as-is** and not a clinical system: submissions are
  research metadata (biomarkers, cancer type, summaries). Do not submit
  patient records or PHI.
- CSRF tokens for cookie-authenticated POSTs are not yet implemented
  (the session cookie is `SameSite=Lax`, which blunts — but does not
  eliminate — the risk); login/registration rate limiting is in place via
  the server's `express-rate-limit` setup.
- **The `frontend/` UI does not call these APIs yet.** Wiring the React
  front end to `/api/auth` and `/api/submissions` is the next integration
  step.

## Tests

```
node --test auth/auth.test.js
```

10 tests: NPI Luhn + NPPES outcomes (verified / not found / mismatch /
network failure → manual review), no-invite and reused/expired invite
rejection, MFA confirmation and approval gating, TOTP login replay
protection, the full happy path (invite → register → MFA → approve →
login → submit → approve → live), abuse cases (pending account submitting,
doctor reviewing, forced-`approved` create), self-review refusal,
versioning/soft-delete/audit behavior, and session tamper/revocation.

HTTP-level integration tests for the `server.js` adapter are in
`server.auth.test.js` at the repo root (run everything with `npm test`).
