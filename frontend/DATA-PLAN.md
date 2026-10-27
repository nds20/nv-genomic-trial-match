# Data Plan

## Context provenance
- `a front end done in React that will be used to uplload reaserch to a precision oncology AI engine to match bio markers` (verbatim build request; defines the core workflow: upload research → AI engine → biomarker matching)
- `what can we try to mock up right now` (verbatim; user explicitly requests a mockup, so demo engine behavior and illustrative biomarker examples are authorized as mockup fixtures, clearly labeled in UI as demo)
- No external context applied beyond the verbatim request; no parent-conversation facts become user records.

## Tested sources
No external live data sources are used. This is a product mockup per explicit request — the matching engine is simulated client/server-side with deterministic demo logic, not a real clinical API. No fetch() to external hosts at runtime.

Imagery not needed: data-dense lab console — genomic visuals are rendered with SVG/CSS (helix, pipeline, confidence bars) and iconography, not photography. No image slots.

## Long-term data behavior
- **Refresh policy**: No scheduled refresh; data changes only when user creates/deletes a case or runs a match.
- **Growth**: Cases accumulate per user; each case holds upload metadata and generated mock matches. List ordered newest first.
- **Ordering**: Cases by created_at desc; matches by confidence desc within a case.
- **Time semantics**: created_at is insertion instant, rendered viewer-local.

## Rejected approaches
- **Tried**: Wiring to a real oncology knowledge base (OncoKB / ClinicalTrials.gov live API)
  **Why rejected**: User asked for a mockup front end right now; a live clinical integration would imply real medical recommendations. Demo engine with clearly labeled illustrative matches (EGFR, KRAS, BRCA1/2, etc. as textbook examples) is honest for a mockup and keeps the focus on the upload → match UX.
