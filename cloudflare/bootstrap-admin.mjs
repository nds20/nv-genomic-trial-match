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
//   BOOTSTRAP_ADMIN_NAME, BOOTSTRAP_ADMIN_EMAIL, BOOTSTRAP_ADMIN_PASSWORD
//
// Optional as a group:
//   BOOTSTRAP_ADMIN_NPI, BOOTSTRAP_ADMIN_LICENSE_NUMBER,
//   BOOTSTRAP_ADMIN_LICENSE_STATE
// The operator who runs this one-time bootstrap is the platform's
// founder/administrator, not a clinician, so the NPI/license gate that
// applies to DOCTOR accounts does not apply to this account. Either set
// all three variables or omit all three; setting only some of them is an
// error. When all three are omitted, the admin row is created with NULL
// clinical fields and npi_verification 'operator_exempt'. When all three
// are set, they are validated exactly as before. Doctor accounts created
// afterwards through the normal invite flow still require full NPI
// verification — this exemption exists only in this operator bootstrap.
// Optional: BOOTSTRAP_NPI_VERIFICATION ('manual_review' by default; only
// used when the NPI/license group above is provided)

import { pbkdf2Sync, randomBytes } from 'node:crypto';

const required = [
  'BOOTSTRAP_ADMIN_NAME', 'BOOTSTRAP_ADMIN_EMAIL', 'BOOTSTRAP_ADMIN_PASSWORD',
];
for (const name of required) {
  if (!process.env[name]) throw new Error(`Set ${name} before running this script.`);
}
if (process.env.BOOTSTRAP_ADMIN_PASSWORD.length < 12) throw new Error('BOOTSTRAP_ADMIN_PASSWORD must be at least 12 characters.');

const clinicalVars = [
  'BOOTSTRAP_ADMIN_NPI', 'BOOTSTRAP_ADMIN_LICENSE_NUMBER', 'BOOTSTRAP_ADMIN_LICENSE_STATE',
];
const providedClinical = clinicalVars.filter((name) => process.env[name]);
if (providedClinical.length > 0 && providedClinical.length < clinicalVars.length) {
  const missingClinical = clinicalVars.filter((name) => !process.env[name]);
  throw new Error(`BOOTSTRAP_ADMIN_NPI, BOOTSTRAP_ADMIN_LICENSE_NUMBER, and BOOTSTRAP_ADMIN_LICENSE_STATE must be provided together or omitted together. Missing: ${missingClinical.join(', ')}. Omit all three for an operator admin account without clinical credentials.`);
}
const hasClinicalCredentials = providedClinical.length === clinicalVars.length;
if (hasClinicalCredentials) {
  if (!/^\d{10}$/.test(process.env.BOOTSTRAP_ADMIN_NPI)) throw new Error('BOOTSTRAP_ADMIN_NPI must be 10 digits.');
  if (!/^[A-Z]{2}$/.test(process.env.BOOTSTRAP_ADMIN_LICENSE_STATE)) throw new Error('BOOTSTRAP_ADMIN_LICENSE_STATE must be a 2-letter state code.');
}

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
const npiVerification = hasClinicalCredentials
  ? (process.env.BOOTSTRAP_NPI_VERIFICATION || 'manual_review')
  : 'operator_exempt';
const npiVerificationDetail = hasClinicalCredentials
  ? 'Bootstrap account created by the database operator.'
  : 'Bootstrap operator account; admin role does not require clinical NPI/license.';
const npiSql = hasClinicalCredentials ? sql(process.env.BOOTSTRAP_ADMIN_NPI) : 'NULL';
const licenseNumberSql = hasClinicalCredentials ? sql(process.env.BOOTSTRAP_ADMIN_LICENSE_NUMBER) : 'NULL';
const licenseStateSql = hasClinicalCredentials ? sql(process.env.BOOTSTRAP_ADMIN_LICENSE_STATE) : 'NULL';

console.log('-- Paste this one statement into the oncology-db D1 console. It creates an ACTIVE, MFA-confirmed admin.');
console.log(`INSERT INTO users (id, name, email, password_hash, npi, license_number, license_state, role, status, npi_verification, npi_verification_detail, totp_secret, mfa_confirmed_at, last_totp_counter, approved_by, approved_at, created_at, updated_at) VALUES (${sql(id)}, ${sql(process.env.BOOTSTRAP_ADMIN_NAME)}, ${sql(process.env.BOOTSTRAP_ADMIN_EMAIL.toLowerCase())}, ${sql(passwordHash)}, ${npiSql}, ${licenseNumberSql}, ${licenseStateSql}, 'admin', 'active', ${sql(npiVerification)}, ${sql(npiVerificationDetail)}, ${sql(totpSecret)}, ${sql(now)}, -1, 'bootstrap', ${sql(now)}, ${sql(now)}, ${sql(now)});`);
console.error(`\nTOTP secret (shown once): ${totpSecret}`);
console.error(`Add it to your authenticator as: Biometric Screening Research:${process.env.BOOTSTRAP_ADMIN_EMAIL.toLowerCase()}`);
