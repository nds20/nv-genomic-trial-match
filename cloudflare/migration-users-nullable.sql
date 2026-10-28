-- One-time migration: make the clinical-credential columns on `users`
-- nullable so the operator bootstrap can create the first admin account
-- without an NPI or state license.
--
-- Databases created from the original cloudflare/schema.sql declared
-- users.npi, users.license_number, and users.license_state as NOT NULL.
-- That constraint is correct for doctor accounts, but the platform
-- operator's own admin account has no clinical credentials (see
-- cloudflare/bootstrap-admin.mjs), and its INSERT uses NULL for those
-- three columns. SQLite/D1 cannot drop a NOT NULL constraint in place,
-- so this file rebuilds the `users` table.
--
-- The rebuilt table is identical to the original in every column, type,
-- default, CHECK, and UNIQUE constraint — the ONLY change is that `npi`,
-- `license_number`, and `license_state` no longer carry NOT NULL. Every
-- existing row is copied across unchanged, and the UNIQUE constraint on
-- `npi` still holds for real values (SQLite permits multiple NULLs in a
-- UNIQUE column, so operator accounts never collide with each other or
-- with doctors).
--
-- Run this ONCE in the oncology-db D1 console, BEFORE running the
-- no-NPI operator bootstrap. It is safe on an empty or populated `users`
-- table, and safe to run again (the rebuild simply repeats).
--
-- Fresh databases do NOT need this file if their `users` table already
-- allows NULL in those three columns.

PRAGMA foreign_keys = OFF;

CREATE TABLE users_nullable (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  npi TEXT UNIQUE,
  license_number TEXT,
  license_state TEXT,
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

INSERT INTO users_nullable (
  id, name, email, password_hash, npi, license_number, license_state,
  role, status, npi_verification, npi_verification_detail, totp_secret,
  mfa_confirmed_at, last_totp_counter, approved_by, approved_at,
  created_at, updated_at
)
SELECT
  id, name, email, password_hash, npi, license_number, license_state,
  role, status, npi_verification, npi_verification_detail, totp_secret,
  mfa_confirmed_at, last_totp_counter, approved_by, approved_at,
  created_at, updated_at
FROM users;

DROP TABLE users;

ALTER TABLE users_nullable RENAME TO users;

PRAGMA foreign_keys = ON;
