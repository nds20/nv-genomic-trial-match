# Oncology Biomarker Matcher — Front End

This directory is a source snapshot of the **Oncology Biomarker Matcher** front
end: a React + TypeScript UI (with a small Bun/TypeScript server layer) built
earlier as a hosted web artifact. It is the clinician-facing companion to this
repository's precision oncology matching engine — where the engine in
`engine/` matches biomarkers to clinical trials, this UI is where research
gets uploaded and results get reviewed.

## What the UI does

- **Case intake** — create a de-identified case (cancer type, stage,
  histology, assay).
- **Research upload** — drag-and-drop or browse for NGS reports, PDFs, and
  VCFs, or load sample files.
- **AI matching pipeline view** — a four-step run visualization:
  Ingest → Extract → Cross-Reference → Rank.
- **Biomarker results** — cards with variant, VAF, classification, AI
  confidence, evidence level, matched therapy, and trial count across
  **16 cancer-type libraries (plus Rare)**, grouped at intake
  (Thoracic/Skin, GI, GU/Gyn, Neuro/Endocrine/Sarcoma), with a case filter and
  coverage grid.
- **Therapy ranking table** for tumor-board review.
- **Clinical Dark theme** — Auto / Light / Clinical Dark toggle (persisted),
  using a deep navy-black, high-contrast palette.
- **Patient-summary export** — a plain-language per-case summary with
  per-finding explanations, stats, and questions for the oncologist, with
  Copy, Download .txt, Download .html, and Print/PDF actions.

The UI is labeled throughout as a demo mockup and is **not for clinical use**.

## Layout

```text
frontend/
  client/            React app (Vite-style build via client/build.mjs)
    src/             App.tsx, api.ts, main.tsx, theme.css, globals.d.ts
    index.html
    tsconfig.json
  server/            Server actions and data layer for the original runtime
    src/             actions.ts, schema.ts
    tsconfig.json
  drizzle/           SQL migrations for the app's data tables
  package.json       Scripts and dependencies from the original runtime
  tsconfig.base.json Shared TypeScript config
  DATA-PLAN.md       Original data plan for the artifact
  space.json         Hosted-runtime descriptor from the original artifact
```

## Running / exploring it

In its original hosted runtime the app was built with Bun 1.3
(`packageManager: bun@1.3.10` in `package.json`):

```bash
bun install
bun run build         # build:server + build:client
bun run typecheck     # tsc --noEmit for client and server
```

## Caveats — read before trying to run this standalone

1. **Hosted-runtime dependency.** `package.json` depends on
   `@hatch/space-sdk` through a local `file:` path from the original hosted
   runtime (`file:/opt/hatch/skills/spaces/ts-runtime/dist/space-sdk.tgz`).
   That package is not published and is not in this repository, so a
   standalone `install` will fail until the dependency is replaced or
   stubbed. This PR lands the UI source for review and porting — it is not a
   turnkey standalone app yet.
2. **Not wired to this repo's engine yet.** The UI currently runs on its own
   demo data and server actions (`server/src/actions.ts`); it does not call
   this repository's matching engine API. Connecting the upload and
   run-match flow to `engine/` is the intended follow-up work.

## Provenance

Snapshot of the "Oncology Biomarker Matcher" web artifact (slug
`oncology-biomarker-matcher`), added so the front end can be reviewed,
ported, and eventually integrated with the matching engine in this repo.
Build outputs, `node_modules`, the local database, and the lockfile (which
references local runtime paths) are intentionally not included.
