# Cloudflare hosting + D1 deployment

This is the production hosting path for **biometricscreeningresearch.net**.
Azure Cosmos DB is no longer part of the production plan.

## Architecture

```text
Browser
  │
  ├─ /api/* ─────────────── Cloudflare Worker (cloudflare/worker.js)
  │                            ├─ Lenhard engine port (cloudflare/src/engine.js)
  │                            ├─ Doctor auth, submissions, review, cases
  │                            └─ Cloudflare D1 binding: DB / oncology-db
  │
  ├─ / ───────────────────── React production build (frontend/dist)
  ├─ /static/* ───────────── Hand-authored HTML5 fallback/public pages
  └─ /legacy/* ───────────── Original dependency-free prototype
```

`wrangler.toml` is at the repository root. Its `[assets]` block points to
`cloudflare/dist`, which is generated—not committed—by
`cloudflare/prepare-assets.mjs`. The assets binding is named `ASSETS`, and
`run_worker_first = ["/api/*"]` ensures API requests execute the Worker
before static-asset lookup.

The Node/Express application remains in the repository as a local
development backup. It is not the Cloudflare production runtime.

## D1 data model

`cloudflare/schema.sql` creates:

| Table | Purpose |
| --- | --- |
| `trials` | Trial catalog (`id`, `name`, required biomarkers JSON) |
| `users` | Doctor/reviewer/admin accounts and MFA state |
| `invites` | Hashed, expiring, single-use registration invites |
| `sessions` | Revocable server-side session records |
| `submissions` | Research submissions and review state |
| `submission_versions` | Retained prior submission content |
| `audit_events` | Append-only application audit trail |
| `matcher_cases` | De-identified clinician cases owned by a user |
| `matcher_uploads` | Upload metadata and extracted biomarker symbols |
| `matcher_matches` | Trial results computed for a case |

`cloudflare/seed.sql` was generated faithfully from `data/trials.json`. It
contains only the four existing trial records; no trial data was invented.

## Intentional Cloudflare divergences

The access rules were not weakened, but the implementation uses Web APIs:

- **Password hashing:** Cloudflare uses PBKDF2-HMAC-SHA256 with a per-user
  salt and 210,000 iterations because the Worker path uses WebCrypto. The
  Node backup uses scrypt. Hashes are therefore not portable between the
  two runtimes.
- **Crypto:** invite hashes, session HMACs, and RFC 6238 TOTP use WebCrypto.
- **NPI:** the same format/Luhn and NPPES logic is used. Network or registry
  failure becomes `manual_review`, never approval.
- **State license:** number/state are collected and reviewed by the
  approving admin; there is still no state-board database integration.
- **Rate limiting:** Express's in-process limiter cannot run in the Worker.
  Configure Cloudflare WAF/rate-limiting rules for `/api/auth/*` and
  `/api/upload` in the dashboard before production use.
- **Upload storage:** uploaded file bytes are processed in memory and are
  not stored. D1 retains file metadata and extracted biomarker symbols for
  authenticated case uploads.
- **Cancer categories:** the React UI preserves the 16 cancer-type intake
  categories plus Rare, Clinical Dark, and summary export. They organize
  cases; trial output comes only from D1 trial criteria actually present.
- **First admin:** there is no HTTP setup endpoint. The first admin is
  created by the database operator using `bootstrap-admin.mjs`, below.

## User setup — do these in order

### 1. Create the D1 database

In Cloudflare:

1. Open **Storage & Databases → D1 SQL Database**.
2. Create a database named exactly `oncology-db`.
3. Open its **Console**.

Paste and run `cloudflare/schema.sql`. If the console rejects a multi-
statement paste, run one `CREATE TABLE` / `CREATE INDEX` statement at a
time. Then paste and run `cloudflare/seed.sql`.

Verify with:

```sql
SELECT id, name, required_biomarkers_json FROM trials ORDER BY id;
```

Expected: `T-001` through `T-004`, matching `data/trials.json`.

### 2. Put the real database ID in `wrangler.toml`

On the D1 database overview, copy its **Database ID**. In the GitHub web
editor, open the root `wrangler.toml` and replace the placeholder on the
actual configuration line inside `[[d1_databases]]`:

```toml
database_id = "YOUR_DATABASE_ID_FROM_THE_D1_OVERVIEW"
```

Do not merely add the ID to a comment. Commit the change directly to the
branch or `main`, as appropriate.

### 3. Set the session secret

The Worker requires `SESSION_SECRET` to be at least 16 characters. Use a
long random value generated locally. Never commit it, paste it into chat,
or put it in `wrangler.toml`.

Dashboard path after the Worker exists:

- Worker **nv-genomic-trial-match → Settings → Variables and Secrets**
- Add `SESSION_SECRET` as a **Secret**

Command-line alternative from a trusted local checkout:

```bash
npx wrangler secret put SESSION_SECRET
```

Optional plain variables are `AUTH_ISSUER`, `INVITE_TTL_HOURS`, and
`SESSION_COOKIE_NAME`.

### 4. Create the first admin in D1

There is deliberately no public first-admin endpoint. From a local clone,
set these only in your local terminal environment:

```text
BOOTSTRAP_ADMIN_NAME
BOOTSTRAP_ADMIN_EMAIL
BOOTSTRAP_ADMIN_PASSWORD
```

The NPI/license variables are **optional for this operator bootstrap**:

```text
BOOTSTRAP_ADMIN_NPI            (optional — see below)
BOOTSTRAP_ADMIN_LICENSE_NUMBER (optional — see below)
BOOTSTRAP_ADMIN_LICENSE_STATE  (optional — see below)
```

The operator who runs this one-time bootstrap is the platform's
founder/administrator, not a clinician, so the NPI/license gate that
applies to doctor accounts does not apply here. The three variables work
as a group — either set all three or omit all three:

- **All three omitted:** the admin is created with `NULL` for `npi`,
  `license_number`, and `license_state`, with `npi_verification` set to
  `operator_exempt` and a note recording why. Never invent an NPI or
  license number for the operator account.
- **All three set:** they are validated exactly as before (NPI = 10
  digits, state = 2-letter code) and `BOOTSTRAP_NPI_VERIFICATION`
  applies (`manual_review` by default).
- **Only some set:** the script stops with an error naming the missing
  variables.

**One-time prerequisite for the no-NPI path:** databases created from
the original `schema.sql` (including the production `oncology-db`)
declared those three columns `NOT NULL`, so the `NULL` insert would be
rejected. Run `cloudflare/migration-users-nullable.sql` once in the
`oncology-db` D1 console **before** running the bootstrap script. It
rebuilds the `users` table with only those three columns made nullable
and preserves every existing row, column, and constraint. Skip it only
if your `users` table already allows `NULL` in those columns.

Then run:

```bash
node cloudflare/bootstrap-admin.mjs
```

The script prints one SQL `INSERT` and displays the admin's TOTP secret
once on the local terminal. Paste the SQL into the `oncology-db` D1 console
and save the TOTP secret in an authenticator app. Do not commit or share
the generated SQL or secret. The resulting account is active and MFA-
confirmed, so it can sign in and issue the first invites.

This exemption exists **only** in this operator bootstrap. Doctor
accounts are still created exclusively through the invite flow and still
require NPI verification (format/Luhn plus NPPES) and a state license
before activation — nothing about doctor registration changes.

### 5. Configure the Cloudflare Git build

Connect the GitHub repository to the Worker named
`nv-genomic-trial-match` and use:

| Setting | Value |
| --- | --- |
| Root directory | Repository root (leave blank/default, or `.` if required) |
| Build command | `npm run build:cloudflare` |
| Deploy command | `npx wrangler deploy` |

The build command installs nothing globally: it runs the React Vite build
and prepares `cloudflare/dist` with the React app at `/`, static pages at
`/static/`, and the original prototype at `/legacy/`.

### 6. Attach the domain

Because this Worker hosts the whole site, use a **Custom Domain**, not an
API route:

1. Worker → **Settings → Domains & Routes → Add → Custom Domain**
2. Enter exactly `biometricscreeningresearch.net`

Handle `www.biometricscreeningresearch.net` separately: either add it as
a second custom domain on the same Worker, or create a redirect to the
apex domain backed by a proxied DNS record. Do not add a competing `/*`
route for the same hostname.

### 7. Verify production

Check these after deployment:

```text
GET https://biometricscreeningresearch.net/api/health
  → {"status":"ok","trialStore":"d1"}

GET https://biometricscreeningresearch.net/api/trials
  → T-001, T-002, T-003, T-004

GET https://biometricscreeningresearch.net/
  → React doctor sign-in / registration / MFA workspace

GET https://biometricscreeningresearch.net/static/
  → Static HTML5 guide and functional matcher page
```

Then sign in as the bootstrap admin, create a doctor invite, and complete:
invite link → registration → NPPES result → MFA enrollment/confirmation →
admin approval → doctor login with a fresh TOTP code → create a case →
upload a biomarker list → view D1 trial matches → submit research → see it
in the review queue as `pending_review`.

## Local development and tests

From the repository root:

```bash
npm install
npm --prefix frontend install
npm run build:cloudflare

npx wrangler d1 execute DB --local --file cloudflare/schema.sql
npx wrangler d1 execute DB --local --file cloudflare/seed.sql
npx wrangler dev
```

Run all tests:

```bash
npm test
```

At the time this port was built, the suite contained 24 tests: the 21
existing Node/auth/engine tests plus 3 Cloudflare/D1 tests covering seed
parity, the D1 auth/review flow, and Worker API + asset routing together.

Frontend checks:

```bash
npm --prefix frontend run typecheck
npm --prefix frontend run build
CI=true npm --prefix frontend run build
```

Bundle validation:

```bash
npx wrangler deploy --dry-run
```
