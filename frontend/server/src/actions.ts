// Legacy hosted-runtime actions were removed from the production path.
//
// The original file contained a Bun/@hatch/space-sdk action layer backed by
// in-process demo match templates. That data source must not be used by the
// Cloudflare application: all production cases, uploads, trial matching,
// doctor auth, submissions, and review actions are implemented by
// `cloudflare/worker.js` and persisted in Cloudflare D1 (see
// `cloudflare/schema.sql`). This module intentionally exports no actions.

export const Actions = {};
