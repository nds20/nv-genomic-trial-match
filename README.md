# NV Genomic Trial Match

An early-stage prototype for comparing a biomarker list with clinical trial criteria. It is not a clinical decision-support system and is not certified as HIPAA compliant.

## The platform: biometricscreeningresearch.net

This repository is growing from the NV Genomic Trial Match prototype into the **precision oncology / biometric screening research platform** launching at **biometricscreeningresearch.net**. The goal: verified doctors submit biomarker screening research, reviewers vet it, and approved research feeds the matching engine that connects biomarker findings to clinical trials — without ever letting unvetted accounts or unreviewed data in.

Three pieces, one repo:

| Piece | Where | What it does |
| --- | --- | --- |
| Matching engine | `engine/` + `server.js` | The original Lenhard AI engine: accepts a biomarker list, compares it with trial criteria (local sample catalog or Azure Cosmos DB), and ranks matching trials. Wired into the running server. |
| Clinician front end | `frontend/` | The Oncology Biomarker Matcher React UI (added in PR #2): research upload, the matching pipeline view, biomarker results across 16 cancer-type libraries, and a patient-summary export. Runs on demo data; **not yet wired to the engine or auth APIs**. |
| Accounts & submissions | `auth/` + routes in `server.js` | Doctor login and research submission flow: invite-only accounts, NPI verification, mandatory MFA, role-based review queue, audit trail. The service layer is **mounted into `server.js`**: REST routes under `/api/auth` and `/api/submissions` run the full flow (see `auth/README.md` for the route table). |

How they fit together: a doctor signs in through `auth/`, submits research (today via the API; the `frontend/` UI still runs on demo data — wiring it to these APIs is the next integration step), the submission waits in the review queue until a reviewer approves it, and only approved research reaches the engine's dataset.

## Run locally

Requires Node.js 18 or newer.

```powershell
npm install
npm start
```

Open `http://localhost:3000`. With no Cosmos DB settings, the app uses the sample catalog in `data/trials.json`.

## Front end: Oncology Biomarker Matcher (`frontend/`)

A React + TypeScript UI (with a small Bun/TypeScript server layer) that began as a hosted web artifact and landed here as a source snapshot in PR #2. Full details live in `frontend/README.md`; in short it provides:

- **Research upload and case intake** — de-identified case creation (cancer type, stage, histology, assay); drag-and-drop or browse for NGS reports, PDFs, and VCFs, or load sample files.
- **AI matching pipeline view** — a four-step visualization: Ingest → Extract → Cross-Reference → Rank.
- **Biomarker results** — cards (variant, VAF, classification, AI confidence, evidence level, matched therapy, trial count) across **16 cancer-type libraries (plus Rare)**, with a case filter and coverage grid, plus a therapy ranking table for tumor-board review.
- **Clinical Dark theme** — Auto / Light / Clinical Dark toggle (persisted), with a deep navy-black, high-contrast palette.
- **Patient-summary export** — a plain-language per-case summary with Copy, Download .txt, Download .html, and Print/PDF actions.

Status and caveats:

- The UI currently runs on its own **demo data** and is labeled throughout as a demo mockup, **not for clinical use**. It is **not yet wired to this repo's engine API** (`/api/trials`, `/api/upload`); connecting the two is an integration step still to come.
- Its `package.json` depends on `@hatch/space-sdk` via a local `file:` path from the original hosted runtime. That package is not published and is not in this repository, so a standalone install fails until the dependency is replaced or stubbed; the snapshot is here for review and porting. In its original runtime it was built with Bun 1.3: `bun install`, `bun run build`, `bun run typecheck` (run inside `frontend/`).

## Doctor accounts and research submissions (`auth/`)

The access-control layer that keeps unverified accounts from messing up the data. Plain Node.js (CommonJS), `node:crypto` only, no new dependencies. The full design document is `auth/README.md`.

- **Invite-only accounts.** No public sign-up: an admin issues a single-use, expiring invite (only its SHA-256 hash is stored), and registration is impossible without one.
- **NPI verification.** Registrants provide an NPI and a state license number/state. The NPI is checked locally (format + the CMS Luhn rule) and against the public **NPPES** registry API, including a rough name match. A registry outage degrades the account to manual review — never to approval.
- **Mandatory MFA.** TOTP (RFC 6238) enrollment *and* confirmation are required before an admin can activate an account. Login is password (scrypt-hashed, per-user salt) + TOTP, with replay protection; sessions are signed, expiring, revocable tokens designed for httpOnly cookies.
- **Roles.** `doctor` submits research and manages only their own submissions; `reviewer` approves/rejects submissions; `admin` manages invites and accounts. Nobody can review their own submission.
- **Review queue.** Every submission lands as `pending_review`. Only a reviewer's approval puts it into the live dataset, and editing an approved submission sends it back through review.
- **Audit trail, versioning, soft deletes.** Every mutation appends to an append-only audit log; edits bump a version counter and archive the prior content instead of overwriting; deletes only set a flag — records are retained.

Configuration: `SESSION_SECRET` (at least 16 characters; when unset the server generates a random per-boot secret and warns — sessions then die on restart, so set it for real deployments), `INVITE_TTL_HOURS` (default 72), `AUTH_STORE_FILE` (default `data/auth-store.json`), `AUTH_ISSUER`, `SESSION_COOKIE_NAME`. Run its tests with `node --test auth/auth.test.js` (or `npm test` for the whole repo).

Mounted in `server.js`: REST routes under `/api/auth` (invites, register, MFA enroll/confirm, login/logout, me, admin user approval) and `/api/submissions` + `/api/review-queue` (create/list/edit/soft-delete, reviewer approve/reject), with the facade's role guards enforced and `AuthError` codes mapped to HTTP responses. The full route table is in `auth/README.md`; HTTP integration tests are in `server.auth.test.js`.

Prototype limits, honestly stated: the store is a single JSON file (its interface is shaped so Azure Cosmos containers can replace it); invite delivery is manual — an admin shares the registration link, no email service is wired yet; the state license is collected but verified by the approving admin, not yet against state board databases. Remaining integration: wiring the `frontend/` UI to these APIs is the next PR.

## Set up Azure Cosmos DB

This app uses the **Azure Cosmos DB for NoSQL** API, not the MongoDB API. In Cosmos DB, the equivalent of a table is a **container**. The app expects one container containing trial documents.

1. In the [Azure portal](https://portal.azure.com), choose **Create a resource** and select **Azure Cosmos DB for NoSQL**.
2. Select your subscription and resource group, choose an account name and a region near your app, and enable the free tier if the option is available. The free tier must be selected when creating the account and is limited to one account per subscription. Check the [current free-tier terms](https://learn.microsoft.com/en-us/azure/cosmos-db/free-tier); free allowances and regional availability can change.
3. After the account is deployed, open **Data Explorer** and create:
   - Database ID: `nv-genomic-trial-match`
   - Container ID: `trials`
   - Partition key: `/id`
4. In Data Explorer, open the `trials` container and use **New Item** to add each trial as a separate JSON document. For example:

```text
{
  "id": "T-001",
  "name": "Lung Cancer Study",
  "requiredBiomarkers": ["EGFR"]
}
```

Repeat **New Item** for every trial, using a unique `id` for each one. The app will not copy the local sample trials into Cosmos automatically. It reads each document’s `id`, `name`, and `requiredBiomarkers` fields.

5. In the Cosmos account, open **Keys** and copy the URI and a primary key. Keep the key private; it grants access to the account. For local testing, set the app’s environment variables in a PowerShell terminal:

```powershell
$env:COSMOS_ENDPOINT = "https://<account-name>.documents.azure.com:443/"
$env:COSMOS_KEY = "<paste-the-primary-key-locally>"
$env:COSMOS_DATABASE = "nv-genomic-trial-match"
$env:COSMOS_CONTAINER = "trials"
npm start
```

Use your actual account URI and key locally; do not paste the key into chat, source files, or GitHub. For a hosted app, put settings in the hosting platform’s protected configuration, not in the browser or repository. The current prototype uses a Cosmos account key; production should move to managed identity and least-privilege access.

6. Open `http://localhost:3000/api/health`. It should report `"trialStore":"cosmos"`. Then open `http://localhost:3000/api/trials` and confirm your trial documents appear. Without all four Cosmos settings, the app uses the local sample catalog instead.

For a small prototype, keep the account in one region and avoid enabling paid features or extra throughput until you understand their cost. Review Azure pricing and configure a budget alert; a budget alert notifies you but does not itself cap spending. `TRUST_PROXY=true` may be set when deployed behind a single trusted reverse proxy so upload throttling uses the client IP.

## Upload format and safeguards

The prototype accepts only UTF-8 `.txt`, `.csv`, `.tsv`, or `.json` biomarker lists, up to 5 MB and 5,000 symbols. Text files must contain one symbol per line; JSON must contain only a `biomarkers` array. Symbols must be present in the trial catalog. Free text, extra columns, and additional JSON fields are rejected. For example:

```json
{ "biomarkers": ["EGFR", "ALK"] }
```

Uploads are held in memory for processing and are not stored or logged by this app. The engine rejects content outside this narrow format, caps file size, rate-limits upload attempts, and adds standard HTTP security headers. These safeguards reduce risk but cannot guarantee that data is de-identified or satisfy HIPAA by themselves.

**Do not upload real patient information or protected health information.** The `auth/` module is now mounted into `server.js`, so doctor accounts, login and the submission review queue are live; the anonymous demo endpoints (`/api/upload`, `/api/trials`) remain unauthenticated and accept only de-identified biomarker lists. The platform has no HIPAA compliance certification. Before use with real clinical data, the deployment needs a documented risk analysis and appropriate administrative, physical, and technical safeguards, including identity/access management, an appropriate business associate agreement and Azure configuration, operational monitoring, and review by qualified privacy/compliance counsel. The matching output is for research exploration only; it is not proof of eligibility or medical advice.

## Verify

```powershell
npm test
```
