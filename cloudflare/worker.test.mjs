import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import worker from './worker.js';
import { CloudflarePlatform } from './src/service.js';
import { generateTotpSecret, hashPassword, totp } from './src/crypto.js';

const ENV = { SESSION_SECRET: 'test-session-secret-0123456789', AUTH_ISSUER: 'Biometric Screening Research' };
const PASSWORD = 'correct horse battery staple';
const trialJson = JSON.parse(await readFile(new URL('../data/trials.json', import.meta.url), 'utf8'));

class Statement {
  constructor(db, sql, params = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...params) { return new Statement(this.db, this.sql, params); }
  async all() {
    const rows = this.db.prepare(this.sql).all(...this.params).map((row) => ({ ...row }));
    return { results: rows, success: true };
  }
  async first() {
    const row = this.db.prepare(this.sql).get(...this.params);
    return row ? { ...row } : null;
  }
  async run() {
    const info = this.db.prepare(this.sql).run(...this.params);
    return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
  }
}

class D1Shim {
  constructor() { this.db = new DatabaseSync(':memory:'); }
  prepare(sql) { return new Statement(this.db, sql); }
  exec(sql) { this.db.exec(sql); }
}

async function makeDb() {
  const db = new D1Shim();
  db.exec(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
  db.exec(await readFile(new URL('./seed.sql', import.meta.url), 'utf8'));
  return db;
}

async function insertUser(platform, { id, name, email, role, npi }) {
  const secret = generateTotpSecret();
  const now = new Date().toISOString();
  await platform.run(
    `INSERT INTO users (id, name, email, password_hash, npi, license_number, license_state, role, status,
      npi_verification, npi_verification_detail, totp_secret, mfa_confirmed_at, last_totp_counter,
      approved_by, approved_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'NY', ?, 'active', 'verified', 'test fixture', ?, ?, -1, 'test', ?, ?, ?)`,
    id, name, email, await hashPassword(PASSWORD), npi, `LIC-${id}`, role, secret, now, now, now, now,
  );
  return { id, name, email, role, status: 'active', secret };
}

const nppesStub = async () => ({
  status: 200,
  json: async () => ({ results: [{ enumeration_type: 'NPI-1', basic: { first_name: 'ADA', last_name: 'LOVELACE', status: 'A' } }] }),
});

test('D1 schema and seed preserve the JSON trial catalog and engine matching', async () => {
  const db = await makeDb();
  const platform = new CloudflarePlatform(db, ENV, { fetchImpl: nppesStub });
  assert.deepEqual(await platform.getTrials(), trialJson);
  const matches = await platform.match(['EGFR', 'ALK']);
  const nsclc = matches.find((match) => match.trialId === 'T-003');
  assert.equal(nsclc.matchScore, '100.00%');
  assert.deepEqual(nsclc.matchedBiomarkers, ['EGFR', 'ALK']);
  // T-001 also scores 100% for EGFR alone; the original engine's stable
  // score-only sort keeps it first on that tie.
  assert.equal(matches[0].trialId, 'T-001');
});

test('D1 auth flow enforces invite, MFA, approval, login, submission, and review', async () => {
  const db = await makeDb();
  const platform = new CloudflarePlatform(db, ENV, { fetchImpl: nppesStub });
  const admin = await insertUser(platform, { id: 'usr_admin', name: 'Admin Root', email: 'admin@example.org', role: 'admin', npi: '1111111111' });
  const reviewerAccount = await insertUser(platform, { id: 'usr_reviewer', name: 'Reviewer Root', email: 'reviewer@example.org', role: 'reviewer', npi: '2222222222' });

  await assert.rejects(
    platform.register({ name: 'Ada Lovelace', email: 'ada@example.org', password: PASSWORD, npi: '1234567893', licenseNumber: 'MD-1', licenseState: 'NY' }),
    (error) => error.code === 'INVITE_REQUIRED',
  );

  const { token } = await platform.createInvite({ createdBy: admin.id, email: 'ada@example.org', role: 'doctor' });
  const doctor = await platform.register({
    inviteToken: token, name: 'Ada Lovelace', email: 'ada@example.org', password: PASSWORD,
    npi: '1234567893', licenseNumber: 'MD-1', licenseState: 'NY',
  });
  assert.equal(doctor.status, 'pending');
  assert.equal(doctor.npiVerification, 'verified');

  const enrollment = await platform.beginMfaEnrollment(doctor.id);
  await assert.rejects(platform.approveUser(admin, doctor.id), (error) => error.code === 'MFA_REQUIRED');
  const confirmAt = Date.now();
  await platform.confirmMfa(doctor.id, await totp(enrollment.secret, { at: confirmAt }), { at: confirmAt });
  const approved = await platform.approveUser(admin, doctor.id);
  assert.equal(approved.status, 'active');

  const loginAt = confirmAt + 31000;
  const loginCode = await totp(enrollment.secret, { at: loginAt });
  const loggedIn = await platform.login(doctor.email, PASSWORD, loginCode, { at: loginAt });
  assert.equal(loggedIn.user.id, doctor.id);
  await assert.rejects(platform.login(doctor.email, PASSWORD, loginCode, { at: loginAt }), (error) => error.code === 'MFA_INVALID_CODE');

  const activeDoctor = await platform.getUserById(doctor.id);
  const submission = await platform.createSubmission(activeDoctor, {
    title: 'BRCA screening research', summary: 'A sufficiently detailed research summary for review.',
    biomarkers: ['BRCA1'], cancerType: 'Breast Cancer',
  });
  assert.equal(submission.status, 'pending_review');
  const queue = await platform.listPendingReview(reviewerAccount);
  assert.equal(queue.length, 1);
  const reviewed = await platform.reviewSubmission(reviewerAccount, submission.id, 'Verified for the live dataset.', 'approved');
  assert.equal(reviewed.status, 'approved');
  assert.equal((await platform.listApprovedSubmissions()).length, 1);

  const edited = await platform.editSubmission(activeDoctor, submission.id, { summary: 'An updated sufficiently detailed research summary for re-review.' });
  assert.equal(edited.version, 2);
  assert.equal(edited.status, 'pending_review');
  assert.equal(edited.history.length, 1);
  const deleted = await platform.deleteSubmission(activeDoctor, submission.id);
  assert.ok(deleted.deletedAt);
  assert.ok((await platform.listAudit({ entityType: 'submission', entityId: submission.id })).length >= 4);
});

test('Worker routes APIs, auth cookies, case uploads, and static assets together', async () => {
  const db = await makeDb();
  const platform = new CloudflarePlatform(db, ENV, { fetchImpl: nppesStub });
  const admin = await insertUser(platform, { id: 'usr_admin', name: 'Admin Root', email: 'admin@example.org', role: 'admin', npi: '1111111111' });
  const assets = {
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      if (path === '/' || path === '/index.html') return new Response('<!doctype html><title>Oncology Biomarker Matcher</title>', { headers: { 'Content-Type': 'text/html' } });
      if (path === '/static/index.html') return new Response('<!doctype html><title>Static</title>', { headers: { 'Content-Type': 'text/html' } });
      return new Response('not found', { status: 404 });
    },
  };
  const env = { DB: db, ASSETS: assets, ...ENV };
  const call = (path, init = {}) => worker.fetch(new Request(`https://biometricscreeningresearch.net${path}`, init), env);

  const health = await call('/api/health');
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok', trialStore: 'd1' });
  assert.deepEqual(await (await call('/api/trials')).json(), trialJson);

  const publicSignup = await call('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'No Invite', email: 'nope@example.org', password: PASSWORD, npi: '1234567893', licenseNumber: 'X', licenseState: 'NY' }) });
  assert.equal(publicSignup.status, 403);
  assert.equal((await publicSignup.json()).code, 'INVITE_REQUIRED');

  const code = await totp(admin.secret);
  const login = await call('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: admin.email, password: PASSWORD, totpCode: code }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('Set-Cookie');
  assert.match(cookie, /bsr_session=/);

  const create = await call('/api/cases', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ label: 'MTB-TEST-001', cancerType: 'Non-Small Cell Lung Cancer', stage: 'Stage IV', histology: 'Adenocarcinoma', sampleType: 'Tissue NGS', priorTherapy: '' }) });
  assert.equal(create.status, 201);
  const { id } = await create.json();

  const form = new FormData();
  form.set('research', new File(['EGFR\nALK\n'], 'biomarkers.txt', { type: 'text/plain' }));
  const upload = await call(`/api/cases/${id}/uploads`, { method: 'POST', headers: { Cookie: cookie }, body: form });
  assert.equal(upload.status, 201);
  assert.deepEqual((await upload.json()).biomarkers, ['EGFR', 'ALK']);

  const detail = await call(`/api/cases/${id}/detail`, { headers: { Cookie: cookie } });
  const detailData = await detail.json();
  assert.equal(detailData.uploads.length, 1);
  assert.equal(detailData.matches.find((match) => match.variant === 'T-003').confidence, 100);
  assert.equal(detailData.matches[0].confidence, 100);

  const root = await call('/');
  assert.match(await root.text(), /Oncology Biomarker Matcher/);
  const fallback = await call('/register?invite=test-token');
  assert.equal(fallback.status, 200);
  assert.match(await fallback.text(), /Oncology Biomarker Matcher/);
  const staticPage = await call('/static/index.html');
  assert.match(await staticPage.text(), /Static/);
});
