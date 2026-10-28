# Static HTML5 fallback pages

These hand-authored pages are copied to `/static/` inside the Cloudflare
asset bundle. They are intentionally separate from the React app:

- `index.html` explains the platform and links to the React workspace at `/`.
- `matcher.html` is functional and calls the production `/api/upload`
  endpoint backed by D1.
- `login.html` and `register.html` explain the secure auth handoff into the
  React workspace; they do not collect passwords or invite tokens themselves.
- `doctor-access.html` and `review-queue.html` document the access and
  review rules.

The primary user-facing application remains the React production build at
the site root. These pages are a resilient public guide/fallback, not a
second implementation of the authenticated workspace.
