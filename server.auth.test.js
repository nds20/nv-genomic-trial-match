'use strict';

// Integration tests for the HTTP adapter that mounts auth/ into server.js.
// Boots an app (via the createApp factory) on an ephemeral port with the
// auth service backed by a JsonFileStore in a temp directory and a stubbed
// NPPES lookup, then drives the whole doctor journey over real HTTP:
// invite -> register -> MFA -> approve -> login -> submit -> review.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('./server');
const { createAuthService, JsonFileStore } = require('./auth');
const { hashPassword } = require('./auth/users');
const { generateSecret, totp } = require('./auth/totp');

const PASSWORD = 'correct horse battery staple';
const SESSION_SECRET = 'integration-test-secret-0123456789';
const ADMIN_EMAIL = 'admin@example.org';
const DOCTOR_EMAIL = 'ada@example.org';
const REVIEWER_EMAIL = 'grace@example.org';

const SAMPLE_SUBMISSION = {
    title: 'BRCA1 screening outcomes in upstate NY',
    summary: 'A cohort study of screening outcomes across 412 participants over three years.',
    biomarkers: ['BRCA1', 'BRCA2'],
    cancerType: 'Breast',
};

let server;
let baseUrl;
let tmpDir;
let adminTotpSecret;
let adminCookie;
let reviewerCookie;
let doctorId;
let doctorTotpSecret;
let submissionId;

async function api(pathname, { method = 'GET', body, cookie } = {}) {
    const res = await fetch(`${baseUrl}${pathname}`, {
        method,
        headers: {
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
            ...(cookie ? { cookie } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON response */ }
    return { status: res.status, json, headers: res.headers };
}

function sessionCookieFrom(result) {
    const setCookies = result.headers.getSetCookie ? result.headers.getSetCookie() : [];
    const found = setCookies.find(c => c.startsWith('bsr_session='));
    return found ? found.split(';')[0] : null;
}

// Logs in with a TOTP code. TOTP steps are 30s and each code is single-use
// (replay protection), so the exact step a previous confirm/login consumed
// is not knowable from the client side: try the current step, then the
// following steps, until one is accepted. Out-of-window and replayed codes
// are rejected without side effects, so retrying is safe.
async function login(email, secret) {
    let lastResult;
    for (const offsetMs of [0, 30_000, 60_000, 90_000]) {
        const result = await api('/api/auth/login', {
            method: 'POST',
            body: { email, password: PASSWORD, totpCode: totp(secret, { at: Date.now() + offsetMs }) },
        });
        if (result.status === 200) {
            const cookie = sessionCookieFrom(result);
            assert.ok(cookie, 'login should set the session cookie');
            return cookie;
        }
        lastResult = result;
    }
    assert.fail(`login for ${email} should succeed: ${JSON.stringify(lastResult?.json)}`);
}

// Registers + MFA-confirms + (via admin) approves a new account, using the
// admin session. Returns the new user's id and TOTP secret.
async function onboardUser({ email, name, npi, role }) {
    const invite = await api('/api/auth/invites', {
        method: 'POST', cookie: adminCookie, body: { email, role },
    });
    assert.equal(invite.status, 201, `invite for ${email}: ${JSON.stringify(invite.json)}`);

    const registered = await api('/api/auth/register', {
        method: 'POST',
        body: {
            inviteToken: invite.json.token, name, email, password: PASSWORD,
            npi, licenseNumber: 'MD-1001', licenseState: 'NY',
        },
    });
    assert.equal(registered.status, 201, `register ${email}: ${JSON.stringify(registered.json)}`);
    assert.equal(registered.json.status, 'pending');

    const enrolled = await api('/api/auth/mfa/enroll', {
        method: 'POST', body: { email, password: PASSWORD },
    });
    assert.equal(enrolled.status, 200, `MFA enroll ${email}: ${JSON.stringify(enrolled.json)}`);
    const secret = enrolled.json.secret;

    const confirmed = await api('/api/auth/mfa/confirm', {
        method: 'POST', body: { email, password: PASSWORD, code: totp(secret) },
    });
    assert.equal(confirmed.status, 200, `MFA confirm ${email}: ${JSON.stringify(confirmed.json)}`);
    assert.ok(confirmed.json.mfaConfirmedAt, 'MFA confirmation timestamp should be set');

    const approved = await api(`/api/auth/users/${registered.json.id}/approve`, {
        method: 'POST', cookie: adminCookie, body: {},
    });
    assert.equal(approved.status, 200, `approve ${email}: ${JSON.stringify(approved.json)}`);
    assert.equal(approved.json.status, 'active');

    return { id: registered.json.id, secret };
}

before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-store-'));
    const store = new JsonFileStore(path.join(tmpDir, 'auth-store.json'));

    // Seed the first admin directly in the store (the same bootstrap an
    // operator would do for the very first account): active, MFA confirmed.
    adminTotpSecret = generateSecret();
    const now = new Date().toISOString();
    await store.put('users', 'usr_admin_seed', {
        id: 'usr_admin_seed',
        name: 'Root Admin',
        email: ADMIN_EMAIL,
        passwordHash: await hashPassword(PASSWORD),
        npi: '1000000004',
        licenseNumber: 'MD-0001',
        licenseState: 'NY',
        role: 'admin',
        status: 'active',
        npiVerification: 'verified',
        npiVerificationDetail: 'Seeded test administrator',
        totpSecret: adminTotpSecret,
        mfaConfirmedAt: now,
        lastTotpCounter: -1,
        approvedBy: null,
        approvedAt: null,
        createdAt: now,
        updatedAt: now,
    });

    const auth = createAuthService({
        store,
        sessionSecret: SESSION_SECRET,
        npiLookup: async () => ({ status: 'verified', detail: 'stubbed registry hit' }),
    });
    const app = createApp(auth);
    server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
    if (server) {
        server.closeAllConnections();
        server.close();
    }
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('unauthenticated requests are rejected with 401', async () => {
    const submit = await api('/api/submissions', { method: 'POST', body: SAMPLE_SUBMISSION });
    assert.equal(submit.status, 401);
    assert.equal(submit.json.code, 'UNAUTHENTICATED');

    const queue = await api('/api/review-queue');
    assert.equal(queue.status, 401);

    const invites = await api('/api/auth/invites', { method: 'POST', body: {} });
    assert.equal(invites.status, 401);
});

test('registration without an invite is refused', async () => {
    const result = await api('/api/auth/register', {
        method: 'POST',
        body: {
            name: 'Eve Random', email: 'eve@example.org', password: PASSWORD,
            npi: '1234567893', licenseNumber: 'MD-9999', licenseState: 'NY',
        },
    });
    assert.equal(result.status, 403);
    assert.equal(result.json.code, 'INVITE_REQUIRED');
});

test('full journey: invite -> register -> MFA -> approve -> login -> submit -> reviewer approve', async () => {
    adminCookie = await login(ADMIN_EMAIL, adminTotpSecret);

    const me = await api('/api/auth/me', { cookie: adminCookie });
    assert.equal(me.status, 200);
    assert.equal(me.json.user.role, 'admin');

    // --- Doctor onboards -------------------------------------------------
    const invite = await api('/api/auth/invites', {
        method: 'POST', cookie: adminCookie, body: { email: DOCTOR_EMAIL, role: 'doctor' },
    });
    assert.equal(invite.status, 201);
    assert.ok(invite.json.token, 'invite returns the raw token once');

    const registered = await api('/api/auth/register', {
        method: 'POST',
        body: {
            inviteToken: invite.json.token, name: 'Ada Lovelace', email: DOCTOR_EMAIL,
            password: PASSWORD, npi: '1234567893', licenseNumber: 'MD-1001', licenseState: 'NY',
        },
    });
    assert.equal(registered.status, 201);
    assert.equal(registered.json.status, 'pending');
    assert.equal(registered.json.passwordHash, undefined, 'password hash never leaves the service');
    doctorId = registered.json.id;

    const enrolled = await api('/api/auth/mfa/enroll', {
        method: 'POST', body: { email: DOCTOR_EMAIL, password: PASSWORD },
    });
    assert.equal(enrolled.status, 200);
    doctorTotpSecret = enrolled.json.secret;
    assert.match(enrolled.json.otpauthUri, /^otpauth:\/\/totp\//);

    const confirmed = await api('/api/auth/mfa/confirm', {
        method: 'POST', body: { email: DOCTOR_EMAIL, password: PASSWORD, code: totp(doctorTotpSecret) },
    });
    assert.equal(confirmed.status, 200);
    assert.ok(confirmed.json.mfaConfirmedAt);

    // With MFA confirmed, a wrong TOTP code at login is rejected.
    const badLogin = await api('/api/auth/login', {
        method: 'POST',
        body: { email: DOCTOR_EMAIL, password: PASSWORD, totpCode: '000000' },
    });
    assert.equal(badLogin.status, 401);
    assert.equal(badLogin.json.code, 'MFA_INVALID_CODE');

    // The doctor can sign in now, but a pending account cannot submit.
    const pendingCookie = await login(DOCTOR_EMAIL, doctorTotpSecret);
    const blocked = await api('/api/submissions', {
        method: 'POST', cookie: pendingCookie, body: SAMPLE_SUBMISSION,
    });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.json.code, 'ACCOUNT_NOT_ACTIVE');

    // --- Admin approves, doctor submits ----------------------------------
    const approved = await api(`/api/auth/users/${doctorId}/approve`, {
        method: 'POST', cookie: adminCookie, body: {},
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.json.status, 'active');

    const created = await api('/api/submissions', {
        method: 'POST', cookie: pendingCookie, body: SAMPLE_SUBMISSION,
    });
    assert.equal(created.status, 201);
    assert.equal(created.json.status, 'pending_review', 'submissions always land in the review queue');
    submissionId = created.json.id;

    const mine = await api('/api/submissions', { cookie: pendingCookie });
    assert.equal(mine.status, 200);
    assert.deepEqual(mine.json.map(s => s.id), [submissionId]);

    // A doctor may not touch the review queue.
    const doctorQueue = await api('/api/review-queue', { cookie: pendingCookie });
    assert.equal(doctorQueue.status, 403);
    assert.equal(doctorQueue.json.code, 'FORBIDDEN');

    // --- Reviewer onboards and approves ----------------------------------
    const reviewer = await onboardUser({
        email: REVIEWER_EMAIL, name: 'Grace Hopper', npi: '1987654321', role: 'reviewer',
    });
    reviewerCookie = await login(REVIEWER_EMAIL, reviewer.secret);

    const queue = await api('/api/review-queue', { cookie: reviewerCookie });
    assert.equal(queue.status, 200);
    assert.deepEqual(queue.json.map(s => s.id), [submissionId]);

    const reviewed = await api(`/api/review-queue/${submissionId}/approve`, {
        method: 'POST', cookie: reviewerCookie, body: { note: 'Methods check out.' },
    });
    assert.equal(reviewed.status, 200);
    assert.equal(reviewed.json.status, 'approved');

    const fetched = await api(`/api/submissions/${submissionId}`, { cookie: pendingCookie });
    assert.equal(fetched.status, 200);
    assert.equal(fetched.json.status, 'approved');

    // --- Logout revokes the session ---------------------------------------
    const logout = await api('/api/auth/logout', { method: 'POST', cookie: pendingCookie, body: {} });
    assert.equal(logout.status, 200);
    const meAfter = await api('/api/auth/me', { cookie: pendingCookie });
    assert.equal(meAfter.status, 401);
});

test('reviewer rejection requires a note, and non-admins cannot list users', async () => {
    const created = await api('/api/submissions', {
        method: 'POST', cookie: adminCookie, body: SAMPLE_SUBMISSION,
    });
    assert.equal(created.status, 201);

    const noNote = await api(`/api/review-queue/${created.json.id}/reject`, {
        method: 'POST', cookie: reviewerCookie, body: {},
    });
    assert.equal(noNote.status, 400);
    assert.equal(noNote.json.code, 'REVIEW_NOTE_REQUIRED');

    const rejected = await api(`/api/review-queue/${created.json.id}/reject`, {
        method: 'POST', cookie: reviewerCookie, body: { note: 'Needs a larger cohort.' },
    });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.json.status, 'rejected');

    const users = await api('/api/auth/users', { cookie: reviewerCookie });
    assert.equal(users.status, 403);
    assert.equal(users.json.code, 'FORBIDDEN');

    const adminUsers = await api('/api/auth/users', { cookie: adminCookie });
    assert.equal(adminUsers.status, 200);
    assert.deepEqual(
        adminUsers.json.map(u => u.email).sort(),
        [ADMIN_EMAIL, DOCTOR_EMAIL, REVIEWER_EMAIL].sort(),
    );
    assert.ok(adminUsers.json.every(u => u.passwordHash === undefined && u.totpSecret === undefined));
});

test('login with a wrong password is rejected', async () => {
    const result = await api('/api/auth/login', {
        method: 'POST',
        body: { email: DOCTOR_EMAIL, password: 'not the right password', totpCode: '123456' },
    });
    assert.equal(result.status, 401);
    assert.equal(result.json.code, 'INVALID_CREDENTIALS');
});
