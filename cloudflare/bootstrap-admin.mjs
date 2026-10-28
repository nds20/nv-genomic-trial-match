// Generates a one-time SQL statement for the FIRST admin account.
//
// This is deliberately a local, operator-run bootstrap rather than an HTTP
// endpoint: the production API has no public sign-up or first-admin setup
// route. The script reads the password from BOOTSTRAP_ADMIN_PASSWORD so it
// does not need to appear in shell history or chat. It prints the SQL and
// the TOTP secret once; store the secret in an authenticator app and do not
// commit either value.
//
// Required environment variables:
//   BOOTSTRAP_ADMIN_NAME, BOOTSTRAP_ADMIN_EMAIL, BOOTSTRAP_ADMIN_PASSWORD,
//   BOOTSTRAP_ADMIN_NPI, BOOTSTRAP_ADMIN_LICENSE_NUMBER,
//   BOOTSTRAP_ADMIN_LICENSE_STATE
// Optional: BOOTSTRAP_NPI_VERIFICATION ('manual_review' by default)

import { pbkdf2Sync, randomBytes } from 'node:crypto';

const required = [
  'BOOTSTRAP_ADMIN_NAME', 'BOOTSTRAP_ADMIN_EMAIL', 'BOOTSTRAP_ADMIN_PASSWORD',
  'BOOTSTRAP_ADMIN_NPI', 'BOOTSTRAP_ADMIN_LICENSE_NUMBER', 'BOOTSTRAP_ADMIN_LICENSE_STATE',
];
for (const name of required) {
  if (!process.env[name]) throw new Error(`Set ${name} before running this script.`);
}
if (process.env.BOOTSTRAP_ADMIN_PASSWORD.length < 12) throw new Error('BOOTSTRAP_ADMIN_PASSWORD must be at least 12 characters.');
if (!/^\d{10}$/.test(process.env.BOOTSTRAP_ADMIN_NPI)) throw new Error('BOOTSTRAP_ADMIN_NPI must be 10 digits.');
if (!/^[A-Z]{2}$/.test(process.env.BOOTSTRAP_ADMIN_LICENSE_STATE)) throw new Error('BOOTSTRAP_ADMIN_LICENSE_STATE must be a 2-letter state code.');

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(bytes) {
  let bits = 0; let value = 0; let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}
function sql(value) { return `'${String(value).replace(/'/g, "''")}'`; }

const salt = randomBytes(16);
const iterations = 210000;
const derived = pbkdf2Sync(process.env.BOOTSTRAP_ADMIN_PASSWORD, salt, iterations, 32, 'sha256');
const passwordHash = ['pbkdf2-sha256', iterations, salt.toString('base64'), derived.toString('base64')].join('$');
const totpSecret = base32(randomBytes(20));
const id = `usr_${crypto.randomUUID()}`;
const now = new Date().toISOString();
const npiVerification = process.env.BOOTSTRAP_NPI_VERIFICATION || 'manual_review';

console.log('-- Paste this one statement into the oncology-db D1 console. It creates an ACTIVE, MFA-confirmed admin.');
console.log(`INSERT INTO users (id, name, email, password_hash, npi, license_number, license_state, role, status, npi_verification, npi_verification_detail, totp_secret, mfa_confirmed_at, last_totp_counter, approved_by, approved_at, created_at, updated_at) VALUES (${sql(id)}, ${sql(process.env.BOOTSTRAP_ADMIN_NAME)}, ${sql(process.env.BOOTSTRAP_ADMIN_EMAIL.toLowerCase())}, ${sql(passwordHash)}, ${sql(process.env.BOOTSTRAP_ADMIN_NPI)}, ${sql(process.env.BOOTSTRAP_ADMIN_LICENSE_NUMBER)}, ${sql(process.env.BOOTSTRAP_ADMIN_LICENSE_STATE)}, 'admin', 'active', ${sql(npiVerification)}, 'Bootstrap account created by the database operator.', ${sql(totpSecret)}, ${sql(now)}, -1, 'bootstrap', ${sql(now)}, ${sql(now)}, ${sql(now)});`);
console.error(`\nTOTP secret (shown once): ${totpSecret}`);
console.error(`Add it to your authenticator as: Biometric Screening Research:${process.env.BOOTSTRAP_ADMIN_EMAIL.toLowerCase()}`);
