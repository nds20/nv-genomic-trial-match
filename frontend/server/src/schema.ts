// Legacy Drizzle schema from the hosted-runtime artifact.
//
// The canonical production schema is `cloudflare/schema.sql`; the Worker
// does not use this file or a separate Bun server. It remains only as a
// historical reference to the original case/upload/match table names.

export const legacySchemaNote =
  "Use cloudflare/schema.sql for the production Cloudflare D1 schema.";
