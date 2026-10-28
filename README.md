# NV Genomic Trial Match

An early-stage prototype for comparing a biomarker list with clinical trial criteria. It is not a clinical decision-support system and is not certified as HIPAA compliant.

## The platform: biometricscreeningresearch.net

This repository is growing from the NV Genomic Trial Match prototype into the **precision oncology / biometric screening research platform** launching at **biometricscreeningresearch.net**. The goal: verified doctors submit biomarker screening research, reviewers vet it, and approved research feeds the matching engine that connects biomarker findings to clinical trials — without ever letting unvetted accounts or unreviewed data in.

Three pieces, one repo:

| Piece | Where | What it does |
| --- | --- | --- |
| Matching engine | `engine/` + `server.js` | The original Lenhard AI engine: accepts a biomarker list, compares it with trial criteria, and ranks matching trials. The Node server is a local backup; the Cloudflare Worker contains a Web API port backed by D1. |
| Clinician front end | `frontend/` | The Oncology Biomarker Matcher React UI: standalone Vite build, doctor-auth flow, authenticated D1-backed cases/uploads, Lenhard trial results, 16 cancer-type intake categories plus Rare, and patient-summary export. |
| Accounts & submissions | `auth/` + routes in `server.js` | Doctor login and research submission flow: invite-only accounts, NPI verification, mandatory MFA, role-based review queue, audit trail. The service layer is **mounted into `server.js`**: REST routes under `/api/auth` and `/api/submissions` run the full flow (see `auth/README.md` for the route table). |

How they fit together on Cloudflare: a doctor signs in through the React UI, manages cases and submits research, the submission waits in the review queue until a reviewer approves it, and only approved research reaches the live dataset. The Node `auth/` module remains the local development implementation; `cloudflare/` is the production implementation.

## Run locally

Requires Node.js 18 or newer.

```powershell
npm install
npm start
```

Open `http://localhost:3000`. The local Node backup uses the sample catalog in `data/trials.json` when Cosmos settings are absent; Cloudflare production uses D1.

## Front end: Oncology Biomarker Matcher (`frontend/`)

A standalone React + TypeScript UI built with Vite and hosted as static
assets by the Cloudflare Worker. It provides:

- **Doctor access** — invite-only registration, NPPES verification flow,
  mandatory TOTP MFA, pending-account locking, and admin invite/user tools.
- **Research submissions and review** — submissions from the UI always
  start as `pending_review`; reviewers/admins use the same UI to approve
  or reject them.
- **Case intake and upload** — de-identified cases across 16 cancer types
  plus Rare; supported biomarker-list uploads are validated by the Worker
  and analyzed against the D1 trial catalog.
- **Trial results** — Lenhard engine results persisted in D1, with cards
  and a ranking table.
- **Clinical Dark theme** — Auto / Light / Clinical Dark toggle (persisted).
- **Patient-summary export** — Copy, Download .txt, Download .html, and
  Print/PDF actions.

Build it with `npm --prefix frontend install`, `npm --prefix frontend run
typecheck`, and `npm --prefix frontend run build`. The old
`@hatch/space-sdk` local dependency and Bun hosted runtime are gone.

## Doctor accounts and research submissions (`auth/`)

The access-control layer that keeps unverified accounts from messing up the data. Plain Node.js (CommonJS), `node:crypto` only, no new dependencies. The full design document is `auth/README.md`.

- **Invite-only accounts.** No public sign-up: an admin issues a single-use, expiring invite (only its SHA-256 hash is stored), and registration is impossible without one.
- **NPI verification.** Registrants provide an NPI and a state license number/state. The NPI is checked locally (format + the CMS Luhn rule) and against the public **NPPES** registry API, including a rough name match. A registry outage degrades the account to manual review — never to approval.
- **Mandatory MFA.** TOTP (RFC 6238) enrollment *and* confirmation are required before an admin can activate an account. Login is password + TOTP (the Node backup uses scrypt; the Cloudflare production path uses PBKDF2-HMAC-SHA256 with a per-user salt), with replay protection; sessions are signed, expiring, revocable tokens designed for httpOnly cookies.
- **Roles.** `doctor` submits research and manages only their own submissions; `reviewer` approves/rejects submissions; `admin` manages invites and accounts. Nobody can review their own submission.
- **Review queue.** Every submission lands as `pending_review`. Only a reviewer's approval puts it into the live dataset, and editing an approved submission sends it back through review.
- **Audit trail, versioning, soft deletes.** Every mutation appends to an append-only audit log; edits bump a version counter and archive the prior content instead of overwriting; deletes only set a flag — records are retained.

Configuration: `SESSION_SECRET` (at least 16 characters; when unset the server generates a random per-boot secret and warns — sessions then die on restart, so set it for real deployments), `INVITE_TTL_HOURS` (default 72), `AUTH_STORE_FILE` (default `data/auth-store.json`), `AUTH_ISSUER`, `SESSION_COOKIE_NAME`. Run its tests with `node --test auth/auth.test.js` (or `npm test` for the whole repo).

Mounted in `server.js`: REST routes under `/api/auth` (invites, register, MFA enroll/confirm, login/logout, me, admin user approval) and `/api/submissions` + `/api/review-queue` (create/list/edit/soft-delete, reviewer approve/reject), with the facade's role guards enforced and `AuthError` codes mapped to HTTP responses. The full route table is in `auth/README.md`; HTTP integration tests are in `server.auth.test.js`.

Prototype limits, honestly stated: the Node backup uses a single JSON file, while Cloudflare production persists auth data in D1; invite delivery is manual — an admin shares the registration link, no email service is wired yet; the state license is collected but verified by the approving admin, not yet against state board databases.

## Cloudflare production deployment

The production plan is now **Cloudflare for hosting, APIs, and data**:

- Worker: `cloudflare/worker.js`, configured by root `wrangler.toml`
- Database: Cloudflare D1, suggested name `oncology-db`, binding `DB`
- Trial schema/seed: `cloudflare/schema.sql` and `cloudflare/seed.sql`
- React assets: generated into the Worker asset bundle by
  `npm run build:cloudflare`
- Static HTML5 fallback: `static/`, served under `/static/`
- Domain: attach `biometricscreeningresearch.net` as a Worker Custom Domain

Follow the exact operator checklist in `cloudflare/README.md`: create
`oncology-db`, run schema then seed, replace `database_id` on the actual
`wrangler.toml` config line, set `SESSION_SECRET` as a Worker secret,
bootstrap the first admin directly in D1, configure the Git build, attach
the domain, and verify `/api/health` and `/api/trials`.

Azure Cosmos instructions and configuration are no longer part of the
production path. The Node `TrialRepository` remains only in the local
development backup.

## Upload format and safeguards

The prototype accepts only UTF-8 `.txt`, `.csv`, `.tsv`, or `.json` biomarker lists, up to 5 MB and 5,000 symbols. Text files must contain one symbol per line; JSON must contain only a `biomarkers` array. Symbols must be present in the trial catalog. Free text, extra columns, and additional JSON fields are rejected. For example:

```json
{ "biomarkers": ["EGFR", "ALK"] }
```

Uploads are held in memory for processing and are not stored or logged by this app. The engine rejects content outside this narrow format, caps file size, rate-limits upload attempts, and adds standard HTTP security headers. These safeguards reduce risk but cannot guarantee that data is de-identified or satisfy HIPAA by themselves.

**Do not upload real patient information or protected health information.** The `auth/` module is now mounted into `server.js`, so doctor accounts, login and the submission review queue are live; the anonymous demo endpoints (`/api/upload`, `/api/trials`) remain unauthenticated and accept only de-identified biomarker lists. The platform has no HIPAA compliance certification. Before use with real clinical data, the deployment needs a documented risk analysis and appropriate administrative, physical, and technical safeguards, including identity/access management, an appropriate business associate agreement and Cloudflare configuration, operational monitoring, and review by qualified privacy/compliance counsel. The matching output is for research exploration only; it is not proof of eligibility or medical advice.

## Verify

```powershell
npm test
```
