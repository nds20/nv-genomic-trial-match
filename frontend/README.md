# Oncology Biomarker Matcher — React Front End

The front end is now a standalone React + TypeScript application built
with Vite. It no longer depends on `@hatch/space-sdk`, Bun, or a local
hosted-runtime package.

## Production wiring

The browser talks directly to the Cloudflare Worker API:

- `/api/auth/me`, login/logout, invite-only registration, and MFA
  enrollment/confirmation
- Admin invite creation, account approval/suspension, and user listing
- `/api/submissions` and `/api/review-queue`
- Authenticated `/api/cases` workspace:
  - create/list/soft-delete de-identified cases
  - upload a supported biomarker list for a case
  - store upload metadata and extracted symbols in D1
  - run/re-run the Lenhard engine against D1 trial criteria
  - persist computed trial matches in D1

The UI requires an **active** account for cases and submissions. Pending
accounts see a locked screen; unauthenticated visitors see sign-in,
invited registration, and MFA confirmation forms.

## Preserved UI capabilities

- Case intake across **16 cancer types plus Rare**
- Case filtering and the coverage grid
- Clinical Dark / Light / System themes (persisted)
- Four-step matching pipeline presentation
- Trial-match cards and ranking table
- Patient-summary export through **Copy**, **Download .txt**,
  **Download .html**, and **Print/PDF**

Important data note: the cancer types organize intake. Results are not
generated from the old hosted runtime's per-cancer demo templates. They
are computed from the uploaded biomarker symbols and the trial records
actually stored in Cloudflare D1.

## Supported uploads

The production engine accepts UTF-8 `.txt`, `.csv`, `.tsv`, and `.json`
biomarker lists up to 5 MB. Text formats contain one recognized symbol per
line; JSON must contain only a `biomarkers` array. It rejects free text,
patient details, extra columns/fields, and unknown symbols. Original file
bytes are not stored.

The earlier UI copy allowed PDF/VCF-style files and only catalogued their
names. That behavior was not real parsing and has been removed from the
production upload flow.

## Build

```bash
npm install
npm run typecheck
npm run build
CI=true npm run build
```

Vite uses `client/` as its root and writes static HTML/CSS/JS to
`frontend/dist/`. The repository-level Cloudflare build copies that output
into the Worker asset bundle:

```bash
npm run build:cloudflare
```

## Layout

```text
frontend/
  client/          React application (Vite root)
    src/App.tsx    Auth, submissions/review, cases, upload, results, export
    src/api.ts     Fetch client for the Worker API
    src/main.tsx   Standalone React Query setup
  dist/            Generated production output (not committed)
  package.json     Standalone npm dependencies and scripts
  vite.config.ts   React + Tailwind Vite build
  server/          Legacy hosted-runtime files, not used in production
```

`frontend/server/src/actions.ts` no longer contains the original demo
match templates or an SDK action layer. The production backend is
`cloudflare/worker.js`; the canonical database schema is
`cloudflare/schema.sql`.
