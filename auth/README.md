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
| `SESSION_SECRET` | HMAC key for session tokens (≥16 chars, **required**) | — |
| `INVITE_TTL_HOURS` | Invite lifetime | `72` |
| `AUTH_STORE_FILE` | JSON store location | `data/auth-store.json` (git-ignored by the repo's `data/*.json` rule) |
| `AUTH_ISSUER` | Name shown in authenticator apps | `Biometric Screening Research` |
| `SESSION_COOKIE_NAME` | Session cookie name | `bsr_session` |

## Mounting into `server.js` (next step — not yet wired)

This PR adds the service layer and its tests; it does **not** change
`server.js`. The intended wiring is a thin HTTP adapter, e.g.:

```js
const { createAuthService } = require('./auth');
const { roles } = require('./auth');

const auth = createAuthService(); // throws if SESSION_SECRET is unset

app.post('/api/auth/invites', /* admin session + role check */, async (req, res) => {
    const { invite, token } = await auth.invites.createInvite({ createdBy: req.user.id, email: req.body.email });
    res.json({ inviteId: invite.id, registrationPath: `/register?invite=${token}` });
});

app.post('/api/auth/register', async (req, res) => res.json(await auth.users.register(req.body)));
app.post('/api/auth/login', async (req, res) => {
    const { token, user } = await auth.login(req.body.email, req.body.password, req.body.totpCode);
    res.set('Set-Cookie', require('./auth/session').sessionCookie(token));
    res.json({ user });
});

const requireActive = roles.authenticate(auth.resolveSessionUser.bind(auth));
app.post('/api/submissions', requireActive, async (req, res) =>
    res.status(201).json(await auth.submissions.createSubmission(req.user, req.body)));
app.get('/api/review-queue', requireActive, roles.authorize('reviewer', 'admin'), async (req, res) =>
    res.json(await auth.submissions.listPendingReview(req.user)));
```

Map `AuthError.status`/`AuthError.code` to HTTP responses in the existing
error-handling middleware.

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
- Rate limiting, CSRF tokens for cookie-authenticated POSTs, and login
  attempt throttling should reuse the repo's existing `helmet` /
  `express-rate-limit` setup when the HTTP adapter lands.

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
