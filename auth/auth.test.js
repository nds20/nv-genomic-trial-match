'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAuthService, MemoryStore } = require('./index');
const { InviteService } = require('./invites');
const { validateNpiFormat, lookupNpi } = require('./npi');
const { totp } = require('./totp');

const SECRET = 'test-session-secret-0123456789';
const ADMIN = { id: 'admin-root', role: 'admin' };
const T0 = Date.parse('2026-01-05T12:00:00Z');
const PASSWORD = 'correct horse battery staple';

// 1234567893 passes the CMS Luhn check for NPIs (verified against RFC-style
// examples published by CMS).
const VALID_NPI = '1234567893';

function makeService(npiLookup) {
    return createAuthService({
        store: new MemoryStore(),
        sessionSecret: SECRET,
        npiLookup: npiLookup || (async () => ({ status: 'verified', detail: 'stubbed registry hit' })),
    });
}

let npiCounter = 0;
async function registerDoctor(auth, { email = 'ada@example.org', name = 'Ada Lovelace', role = 'doctor', npi } = {}) {
    const { token } = await auth.invites.createInvite({ createdBy: ADMIN.id, email, role });
    return auth.users.register({
        inviteToken: token,
        name,
        email,
        password: PASSWORD,
        npi: npi || String(1200000000 + (npiCounter += 1)),
        licenseNumber: 'MD-1001',
        licenseState: 'NY',
    });
}

async function enrollAndConfirm(auth, userId, at = T0) {
    const { secret } = await auth.users.beginMfaEnrollment(userId);
    await auth.users.confirmMfa(userId, totp(secret, { at }), { at });
    return secret;
}

async function makeActiveDoctor(auth, options) {
    const user = await registerDoctor(auth, options);
    const secret = await enrollAndConfirm(auth, user.id);
    await auth.users.approveUser(ADMIN, user.id);
    return { user: await auth.users.getById(user.id), secret };
}

const SAMPLE = {
    title: 'BRCA1 screening outcomes in upstate NY',
    summary: 'A cohort study of screening outcomes across 412 participants over three years.',
    biomarkers: ['BRCA1', 'BRCA2'],
    cancerType: 'Breast',
};

test('NPI format validation follows the CMS Luhn rule', () => {
    assert.equal(validateNpiFormat(VALID_NPI), true);
    assert.equal(validateNpiFormat('1234567890'), false); // bad check digit
    assert.equal(validateNpiFormat('123456789'), false); // too short
    assert.equal(validateNpiFormat('9234567893'), false); // must start 1 or 2
    assert.equal(validateNpiFormat('abcdefghij'), false);
});

test('NPPES lookup: verified, not found, and network failure degrades to manual review', async () => {
    const found = async () => ({
        status: 200,
        json: async () => ({
            results: [{ enumeration_type: 'NPI-1', basic: { first_name: 'ADA', last_name: 'LOVELACE', status: 'A' } }],
        }),
    });
    const verified = await lookupNpi(VALID_NPI, { suppliedName: 'Ada Lovelace', fetchImpl: found });
    assert.equal(verified.status, 'verified');

    const empty = async () => ({ status: 200, json: async () => ({ result_count: 0, results: [] }) });
    const missing = await lookupNpi(VALID_NPI, { suppliedName: 'Ada Lovelace', fetchImpl: empty });
    assert.equal(missing.status, 'not_found');

    const mismatch = await lookupNpi(VALID_NPI, { suppliedName: 'Grace Hopper', fetchImpl: found });
    assert.equal(mismatch.status, 'mismatch');

    const down = async () => { throw new Error('ECONNRESET'); };
    const degraded = await lookupNpi(VALID_NPI, { suppliedName: 'Ada Lovelace', fetchImpl: down });
    assert.equal(degraded.status, 'manual_review');
});

test('registration is impossible without an invite, and invites are single-use', async () => {
    const auth = makeService();
    await assert.rejects(
        auth.users.register({
            name: 'Ada Lovelace', email: 'ada@example.org', password: PASSWORD,
            npi: VALID_NPI, licenseNumber: 'MD-1001', licenseState: 'NY',
        }),
        err => err.code === 'INVITE_REQUIRED',
    );
    await assert.rejects(
        registerDoctor(auth).then(() => registerDoctor(auth, { email: 'ada@example.org' })),
        // second registration attempt with a *fresh* invite but same email is a different failure;
        // the single-use property itself is proven below.
        err => ['EMAIL_TAKEN', 'INVITE_USED', 'INVITE_EMAIL_MISMATCH'].includes(err.code),
    );

    const { token } = await auth.invites.createInvite({ createdBy: ADMIN.id, email: 'grace@example.org' });
    const registration = {
        inviteToken: token, name: 'Grace Hopper', email: 'grace@example.org', password: PASSWORD,
        npi: VALID_NPI, licenseNumber: 'MD-2002', licenseState: 'VA',
    };
    // First use is blocked only because the NPI is now taken by Ada; use a
    // second valid-format NPI to isolate the single-use behaviour.
    registration.npi = '1987654321';
    // 1987654321 does not pass Luhn with the stubbed lookup (stub ignores
    // format), so registration succeeds and consumes the invite.
    await auth.users.register(registration);
    await assert.rejects(auth.users.register(registration), err => err.code === 'INVITE_USED');
});

test('an expired invite is rejected', async () => {
    const store = new MemoryStore();
    const invites = new InviteService(store, {});
    const { invite, token } = await invites.createInvite({ createdBy: ADMIN.id });
    const stored = await store.get('invites', invite.id);
    stored.expiresAt = new Date(Date.now() - 1000).toISOString();
    await store.put('invites', invite.id, stored);
    await assert.rejects(invites.peekInvite(token), err => err.code === 'INVITE_EXPIRED');
    await assert.rejects(invites.peekInvite('not-a-real-token'), err => err.code === 'INVITE_INVALID');
});

test('MFA: wrong code fails confirmation, approval requires MFA, replayed login code fails', async () => {
    const auth = makeService();
    const user = await registerDoctor(auth);

    // Approval before MFA confirmation is refused.
    await assert.rejects(auth.users.approveUser(ADMIN, user.id), err => err.code === 'MFA_REQUIRED');

    const { secret } = await auth.users.beginMfaEnrollment(user.id);
    await assert.rejects(
        auth.users.confirmMfa(user.id, '000000', { at: T0 }),
        err => err.code === 'MFA_INVALID_CODE',
    );
    await auth.users.confirmMfa(user.id, totp(secret, { at: T0 }), { at: T0 });
    await auth.users.approveUser(ADMIN, user.id);

    // Login at a later time step works...
    const loginAt = T0 + 31_000;
    const { token } = await auth.login(user.email, PASSWORD, totp(secret, { at: loginAt }), { at: loginAt });
    assert.ok(await auth.sessions.verifySessionToken(token));

    // ...but replaying the same code does not.
    await assert.rejects(
        auth.login(user.email, PASSWORD, totp(secret, { at: loginAt }), { at: loginAt }),
        err => err.code === 'MFA_INVALID_CODE',
    );
    // Wrong password never reaches MFA.
    await assert.rejects(
        auth.login(user.email, 'wrong password entirely', totp(secret, { at: loginAt + 31_000 }), { at: loginAt + 31_000 }),
        err => err.code === 'INVALID_CREDENTIALS',
    );
});

test('happy path: invite -> register -> verify -> MFA -> approve -> login -> submit -> review -> live', async () => {
    const auth = makeService();
    const { user: doctor } = await makeActiveDoctor(auth);
    assert.equal(doctor.status, 'active');

    const { user: reviewer } = await makeActiveDoctor(auth, {
        email: 'rev@example.org', name: 'Rhea Viewer', role: 'reviewer',
    });

    const submission = await auth.submissions.createSubmission(doctor, SAMPLE);
    assert.equal(submission.status, 'pending_review');
    assert.equal((await auth.submissions.listApproved()).length, 0);

    const approved = await auth.submissions.approveSubmission(reviewer, submission.id, { note: 'Methods check out.' });
    assert.equal(approved.status, 'approved');
    assert.equal((await auth.submissions.listApproved()).length, 1);

    const trail = await auth.submissions.auditTrailFor(submission.id);
    assert.deepEqual(trail.map(e => e.action), ['submission.created', 'submission.approved']);
});

test('abuse cases: pending accounts cannot submit, doctors cannot review, no direct-to-live path', async () => {
    const auth = makeService();

    // Pending (registered, never MFA-confirmed/approved) account.
    const pending = await registerDoctor(auth, { email: 'pending@example.org' });
    const pendingRecord = await auth.users.getById(pending.id);
    await assert.rejects(
        auth.submissions.createSubmission(pendingRecord, SAMPLE),
        err => err.code === 'ACCOUNT_NOT_ACTIVE',
    );

    const { user: doctor } = await makeActiveDoctor(auth, { email: 'doc2@example.org' });
    // Even asking for "approved" status cannot create a live record.
    const sneaky = await auth.submissions.createSubmission(doctor, { ...SAMPLE, status: 'approved' });
    assert.equal(sneaky.status, 'pending_review');

    // A doctor cannot approve anything, including that submission.
    await assert.rejects(
        auth.submissions.approveSubmission(doctor, sneaky.id, {}),
        err => err.code === 'FORBIDDEN',
    );
    // Rejection without a note is refused.
    const { user: reviewer } = await makeActiveDoctor(auth, { email: 'rev2@example.org', name: 'Rex Viewer', role: 'reviewer' });
    await assert.rejects(
        auth.submissions.rejectSubmission(reviewer, sneaky.id, {}),
        err => err.code === 'REVIEW_NOTE_REQUIRED',
    );
});

test('self-review is forbidden even for admins', async () => {
    const auth = makeService();
    const { user: adminUser } = await makeActiveDoctor(auth, { email: 'root@example.org', name: 'Root Admin', role: 'admin' });
    const own = await auth.submissions.createSubmission(adminUser, SAMPLE);
    await assert.rejects(
        auth.submissions.approveSubmission(adminUser, own.id, {}),
        err => err.code === 'SELF_REVIEW_FORBIDDEN',
    );
});

test('edits version instead of overwriting, re-review after approval, deletes are soft', async () => {
    const auth = makeService();
    const { user: doctor } = await makeActiveDoctor(auth);
    const { user: reviewer } = await makeActiveDoctor(auth, { email: 'rev3@example.org', name: 'Rae Viewer', role: 'reviewer' });

    const submission = await auth.submissions.createSubmission(doctor, SAMPLE);
    await auth.submissions.approveSubmission(reviewer, submission.id, { note: 'ok' });
    assert.equal((await auth.submissions.listApproved()).length, 1);

    const edited = await auth.submissions.editSubmission(doctor, submission.id, {
        summary: 'Updated: extended cohort follow-up to five years with the same screening protocol.',
    });
    assert.equal(edited.version, 2);
    assert.equal(edited.history.length, 1);
    assert.equal(edited.history[0].summary, SAMPLE.summary);
    // Edited content must be re-reviewed before it is live again.
    assert.equal(edited.status, 'pending_review');
    assert.equal((await auth.submissions.listApproved()).length, 0);

    await auth.submissions.deleteSubmission(doctor, submission.id);
    assert.equal((await auth.submissions.listMine(doctor)).length, 0);
    const retained = await auth.store.get('submissions', submission.id);
    assert.ok(retained.deletedAt, 'record is retained with a deletion timestamp');

    const actions = (await auth.submissions.auditTrailFor(submission.id)).map(e => e.action);
    assert.deepEqual(actions, ['submission.created', 'submission.approved', 'submission.edited', 'submission.deleted']);
});

test('session tokens are signed, expiring and revocable', async () => {
    const auth = makeService();
    const { user: doctor, secret } = await makeActiveDoctor(auth);
    const loginAt = T0 + 62_000;
    const { token, session } = await auth.login(doctor.email, PASSWORD, totp(secret, { at: loginAt }), { at: loginAt });

    const [payload, signature] = token.split('.');
    const tampered = `${payload}.${signature.slice(0, -2)}xx`;
    assert.equal(await auth.sessions.verifySessionToken(tampered), null);
    assert.equal(await auth.sessions.verifySessionToken('garbage'), null);

    await auth.logout(session.id);
    assert.equal(await auth.sessions.verifySessionToken(token), null);
});
