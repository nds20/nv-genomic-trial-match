-- Precision Oncology / Biometric Screening Research — Cloudflare D1 schema.
-- Run this in the D1 console for the database named in wrangler.toml
-- (suggested database name: oncology-db), then run seed.sql.

CREATE TABLE IF NOT EXISTS trials (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  required_biomarkers_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  npi TEXT NOT NULL UNIQUE,
  license_number TEXT NOT NULL,
  license_state TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('doctor', 'reviewer', 'admin')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'suspended')),
  npi_verification TEXT NOT NULL,
  npi_verification_detail TEXT,
  totp_secret TEXT,
  mfa_confirmed_at TEXT,
  last_totp_counter INTEGER NOT NULL DEFAULT -1,
  approved_by TEXT,
  approved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  email TEXT COLLATE NOCASE,
  role TEXT NOT NULL CHECK (role IN ('doctor', 'reviewer', 'admin')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  used_by_user_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_invites_token_hash ON invites(token_hash);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  submitted_by TEXT NOT NULL REFERENCES users(id),
  submitter_email TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  biomarkers_json TEXT NOT NULL DEFAULT '[]',
  cancer_type TEXT NOT NULL,
  source_url TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending_review', 'approved', 'rejected')),
  version INTEGER NOT NULL DEFAULT 1,
  review_note TEXT,
  reviewed_by TEXT,
  reviewed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status, deleted_at);
CREATE INDEX IF NOT EXISTS idx_submissions_user ON submissions(submitted_by, deleted_at);

CREATE TABLE IF NOT EXISTS submission_versions (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES submissions(id),
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  biomarkers_json TEXT NOT NULL DEFAULT '[]',
  cancer_type TEXT NOT NULL,
  source_url TEXT,
  status TEXT NOT NULL,
  edited_at TEXT NOT NULL,
  UNIQUE (submission_id, version)
);

-- Append-only by application design: the Worker exposes record/list
-- operations for this table and no update/delete path.
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  actor_id TEXT,
  actor_role TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_events(entity_type, entity_id, at);

CREATE TABLE IF NOT EXISTS matcher_cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  label TEXT NOT NULL,
  cancer_type TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'Stage IV',
  histology TEXT NOT NULL DEFAULT '',
  sample_type TEXT NOT NULL DEFAULT 'Tissue NGS',
  prior_therapy TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'intake' CHECK (status IN ('intake', 'processing', 'matched')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_cases_owner ON matcher_cases(owner_user_id, deleted_at);

CREATE TABLE IF NOT EXISTS matcher_uploads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL REFERENCES matcher_cases(id),
  file_name TEXT NOT NULL,
  file_kind TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  biomarkers_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_uploads_case ON matcher_uploads(case_id);

CREATE TABLE IF NOT EXISTS matcher_matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL REFERENCES matcher_cases(id),
  trial_id TEXT NOT NULL,
  trial_name TEXT NOT NULL,
  required_biomarkers_json TEXT NOT NULL DEFAULT '[]',
  matched_biomarkers_json TEXT NOT NULL DEFAULT '[]',
  match_score TEXT NOT NULL,
  score_value REAL NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (case_id, trial_id)
);
CREATE INDEX IF NOT EXISTS idx_matches_case ON matcher_matches(case_id);
