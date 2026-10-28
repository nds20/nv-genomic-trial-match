import { fail } from './errors.js';
import { LenhardEngine, extensionOf } from './engine.js';
import {
  generateTotpSecret, hashPassword, hmacSha256, otpauthUri, sha256Hex,
  timingSafeEqual, verifyPassword, verifyTotp, base64UrlToBytes, bytesToBase64Url,
} from './crypto.js';
import { lookupNpi } from './npi.js';

const ROLES = ['doctor', 'reviewer', 'admin'];
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const encoder = new TextEncoder();

function nowIso() { return new Date().toISOString(); }
function newId(prefix) { return `${prefix}_${crypto.randomUUID()}`; }
function parseJson(value, fallback) {
  try { return JSON.parse(value ?? ''); } catch { return fallback; }
}
function isValidRole(role) { return ROLES.includes(role); }

function publicUser(user) {
  if (!user) return null;
  const { passwordHash, totpSecret, ...rest } = user;
  return { ...rest, mfaEnrolled: Boolean(totpSecret) };
}

function userFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    passwordHash: row.password_hash,
    npi: row.npi,
    licenseNumber: row.license_number,
    licenseState: row.license_state,
    role: row.role,
    status: row.status,
    npiVerification: row.npi_verification,
    npiVerificationDetail: row.npi_verification_detail,
    totpSecret: row.totp_secret,
    mfaConfirmedAt: row.mfa_confirmed_at,
    lastTotpCounter: row.last_totp_counter,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function submissionFromRow(row, history = []) {
  if (!row) return null;
  return {
    id: row.id,
    submittedBy: row.submitted_by,
    submitterEmail: row.submitter_email,
    title: row.title,
    summary: row.summary,
    biomarkers: parseJson(row.biomarkers_json, []),
    cancerType: row.cancer_type,
    sourceUrl: row.source_url,
    status: row.status,
    version: row.version,
    history,
    reviewNote: row.review_note,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    deletedBy: row.deleted_by,
  };
}

function validateSubmissionContent({ title, summary, biomarkers, cancerType }) {
  if (!title || typeof title !== 'string' || title.trim().length < 4) {
    fail('SUBMISSION_INVALID', 'A submission needs a descriptive title.');
  }
  if (!summary || typeof summary !== 'string' || summary.trim().length < 20) {
    fail('SUBMISSION_INVALID', 'A submission needs a summary of at least 20 characters.');
  }
  if (!Array.isArray(biomarkers) || biomarkers.length === 0 ||
      biomarkers.some((b) => typeof b !== 'string' || b.trim() === '')) {
    fail('SUBMISSION_INVALID', 'A submission must list at least one biomarker.');
  }
  if (!cancerType || typeof cancerType !== 'string') {
    fail('SUBMISSION_INVALID', 'A submission must name the cancer type studied.');
  }
}

export class CloudflarePlatform {
  constructor(db, env = {}, { fetchImpl } = {}) {
    if (!db) throw new Error('A D1 database binding is required.');
    this.db = db;
    this.env = env;
    this.fetchImpl = fetchImpl;
    this.engine = new LenhardEngine();
    this.issuer = env.AUTH_ISSUER || 'Biometric Screening Research';
    const ttlHours = Number(env.INVITE_TTL_HOURS);
    this.inviteTtlMs = (Number.isFinite(ttlHours) && ttlHours > 0 ? ttlHours : 72) * 60 * 60 * 1000;
    this.sessionSecret = env.SESSION_SECRET ? String(env.SESSION_SECRET) : '';
  }

  requireSessionSecret() {
    if (this.sessionSecret.length < 16) {
      fail('SESSION_SECRET_MISSING', 'SESSION_SECRET must be set to at least 16 characters.', 500);
    }
    return this.sessionSecret;
  }

  async all(sql, ...params) {
    const result = await this.db.prepare(sql).bind(...params).all();
    return result.results || [];
  }

  async first(sql, ...params) {
    return this.db.prepare(sql).bind(...params).first();
  }

  async run(sql, ...params) {
    return this.db.prepare(sql).bind(...params).run();
  }

  async audit(actor, action, entityType, entityId, details = {}) {
    await this.run(
      `INSERT INTO audit_events (id, at, actor_id, actor_role, action, entity_type, entity_id, details_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      newId('aud'), nowIso(), actor?.id || null, actor?.role || null, action, entityType, entityId, JSON.stringify(details),
    );
  }

  async listAudit({ entityType, entityId } = {}) {
    let sql = 'SELECT * FROM audit_events';
    const clauses = [];
    const params = [];
    if (entityType) { clauses.push('entity_type = ?'); params.push(entityType); }
    if (entityId) { clauses.push('entity_id = ?'); params.push(entityId); }
    if (clauses.length) sql += ` WHERE ${clauses.join(' AND ')}`;
    sql += ' ORDER BY at ASC, rowid ASC';
    const rows = await this.all(sql, ...params);
    return rows.map((row) => ({
      id: row.id, at: row.at, actorId: row.actor_id, actorRole: row.actor_role,
      action: row.action, entityType: row.entity_type, entityId: row.entity_id,
      details: parseJson(row.details_json, {}),
    }));
  }

  // --- Trials and public matcher -------------------------------------------
  async getTrials() {
    const rows = await this.all('SELECT id, name, required_biomarkers_json FROM trials ORDER BY id ASC');
    return rows.map((row) => {
      const requiredBiomarkers = parseJson(row.required_biomarkers_json, null);
      if (typeof row.id !== 'string' || typeof row.name !== 'string' || !Array.isArray(requiredBiomarkers) ||
          !requiredBiomarkers.every((value) => typeof value === 'string')) {
        throw new Error('D1 contains a trial with an invalid schema.');
      }
      return { id: row.id, name: row.name, requiredBiomarkers };
    });
  }

  async match(biomarkers) {
    return this.engine.match(biomarkers, await this.getTrials());
  }

  async analyzeFile(file) {
    return this.engine.analyzeResearchFile(file, await this.getTrials());
  }

  // --- Invites ---------------------------------------------------------------
  async createInvite({ createdBy, email = null, role = 'doctor' } = {}) {
    if (!createdBy) fail('INVITE_CREATOR_REQUIRED', 'Invites must record which admin created them.');
    if (!isValidRole(role)) fail('INVALID_ROLE', `Unknown role: ${role}`);
    const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
    let binary = '';
    for (const byte of tokenBytes) binary += String.fromCharCode(byte);
    const token = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    const now = new Date();
    const invite = {
      id: newId('inv'), tokenHash: await sha256Hex(token),
      email: email ? String(email).toLowerCase() : null, role, createdBy,
      createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + this.inviteTtlMs).toISOString(),
      usedAt: null, usedByUserId: null,
    };
    await this.run(
      `INSERT INTO invites (id, token_hash, email, role, created_by, created_at, expires_at, used_at, used_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      invite.id, invite.tokenHash, invite.email, invite.role, invite.createdBy,
      invite.createdAt, invite.expiresAt, invite.usedAt, invite.usedByUserId,
    );
    return { invite: { ...invite, tokenHash: undefined }, token };
  }

  async findValidInvite(token) {
    if (!token || typeof token !== 'string') fail('INVITE_REQUIRED', 'Registration requires an invitation.', 403);
    const row = await this.first('SELECT * FROM invites WHERE token_hash = ?', await sha256Hex(token));
    if (!row) fail('INVITE_INVALID', 'This invitation is not recognized.', 403);
    if (row.used_at) fail('INVITE_USED', 'This invitation has already been used.', 403);
    if (Date.now() > Date.parse(row.expires_at)) fail('INVITE_EXPIRED', 'This invitation has expired. Ask an admin for a new one.', 403);
    return row;
  }

  async peekInvite(token) {
    const invite = await this.findValidInvite(token);
    return { email: invite.email, role: invite.role, expiresAt: invite.expires_at };
  }

  async consumeInvite(token, userId) {
    const invite = await this.findValidInvite(token);
    const usedAt = nowIso();
    await this.run('UPDATE invites SET used_at = ?, used_by_user_id = ? WHERE id = ?', usedAt, userId, invite.id);
    return invite;
  }

  async listInvites() {
    const rows = await this.all('SELECT id, email, role, created_by, created_at, expires_at, used_at, used_by_user_id FROM invites ORDER BY created_at DESC');
    return rows.map((row) => ({
      id: row.id, email: row.email, role: row.role, createdBy: row.created_by,
      createdAt: row.created_at, expiresAt: row.expires_at, usedAt: row.used_at, usedByUserId: row.used_by_user_id,
    }));
  }

  // --- Users -----------------------------------------------------------------
  async getUserById(id) {
    return userFromRow(await this.first('SELECT * FROM users WHERE id = ?', id));
  }

  async getUserByEmail(email) {
    return userFromRow(await this.first('SELECT * FROM users WHERE email = ? COLLATE NOCASE', String(email || '').toLowerCase()));
  }

  async listUsers() {
    const rows = await this.all('SELECT * FROM users ORDER BY created_at ASC');
    return rows.map((row) => publicUser(userFromRow(row)));
  }

  async register({ inviteToken, name, email, password, npi, licenseNumber, licenseState } = {}) {
    if (!name || !email || !npi || !licenseNumber || !licenseState) {
      fail('REGISTRATION_INCOMPLETE', 'Name, email, NPI, license number and license state are all required.');
    }
    const inviteInfo = await this.peekInvite(inviteToken);
    const normalizedEmail = String(email).toLowerCase();
    if (inviteInfo.email && inviteInfo.email !== normalizedEmail) {
      fail('INVITE_EMAIL_MISMATCH', 'This invitation was issued to a different email address.', 403);
    }
    if (await this.getUserByEmail(normalizedEmail)) fail('EMAIL_TAKEN', 'An account with this email already exists.', 409);
    if (await this.first('SELECT id FROM users WHERE npi = ?', String(npi))) {
      fail('NPI_TAKEN', 'An account with this NPI already exists.', 409);
    }
    const assignedRole = inviteInfo.role || 'doctor';
    if (!isValidRole(assignedRole)) fail('INVALID_ROLE', `Unknown role: ${assignedRole}`);
    if (!/^[A-Z]{2}$/.test(String(licenseState).toUpperCase())) {
      fail('INVALID_LICENSE_STATE', 'License state must be a 2-letter state code.');
    }

    const npiResult = await lookupNpi(String(npi), {
      suppliedName: name,
      ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
    });
    if (['invalid', 'not_found', 'mismatch'].includes(npiResult.status)) {
      fail('NPI_VERIFICATION_FAILED', `We could not verify this NPI: ${npiResult.detail}`, 422);
    }

    const now = nowIso();
    const user = {
      id: newId('usr'), name: String(name), email: normalizedEmail,
      passwordHash: await hashPassword(password), npi: String(npi),
      licenseNumber: String(licenseNumber), licenseState: String(licenseState).toUpperCase(),
      role: assignedRole, status: 'pending', npiVerification: npiResult.status,
      npiVerificationDetail: npiResult.detail, totpSecret: null, mfaConfirmedAt: null,
      lastTotpCounter: -1, approvedBy: null, approvedAt: null, createdAt: now, updatedAt: now,
    };
    try {
      await this.run(
        `INSERT INTO users (id, name, email, password_hash, npi, license_number, license_state, role, status,
          npi_verification, npi_verification_detail, totp_secret, mfa_confirmed_at, last_totp_counter,
          approved_by, approved_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        user.id, user.name, user.email, user.passwordHash, user.npi, user.licenseNumber, user.licenseState,
        user.role, user.status, user.npiVerification, user.npiVerificationDetail, user.totpSecret,
        user.mfaConfirmedAt, user.lastTotpCounter, user.approvedBy, user.approvedAt, user.createdAt, user.updatedAt,
      );
    } catch (error) {
      if (/users\.email/i.test(String(error.message))) fail('EMAIL_TAKEN', 'An account with this email already exists.', 409);
      if (/users\.npi/i.test(String(error.message))) fail('NPI_TAKEN', 'An account with this NPI already exists.', 409);
      throw error;
    }
    await this.consumeInvite(inviteToken, user.id);
    await this.audit(user, 'user.registered', 'user', user.id, { email: user.email, npiVerification: npiResult.status });
    return publicUser(user);
  }

  async mustFindUser(userId) {
    const user = await this.getUserById(userId);
    if (!user) fail('USER_NOT_FOUND', 'User not found.', 404);
    return user;
  }

  async beginMfaEnrollment(userId) {
    const user = await this.mustFindUser(userId);
    const secret = generateTotpSecret();
    await this.run('UPDATE users SET totp_secret = ?, mfa_confirmed_at = NULL, updated_at = ? WHERE id = ?', secret, nowIso(), user.id);
    return { secret, otpauthUri: otpauthUri({ issuer: this.issuer, account: user.email, secret }) };
  }

  async confirmMfa(userId, code, { at } = {}) {
    const user = await this.mustFindUser(userId);
    if (!user.totpSecret) fail('MFA_NOT_ENROLLED', 'MFA enrollment has not been started.');
    const counter = await verifyTotp(user.totpSecret, code, { at });
    if (counter === -1) fail('MFA_INVALID_CODE', 'That authenticator code is not valid.', 401);
    const confirmedAt = nowIso();
    await this.run(
      'UPDATE users SET mfa_confirmed_at = ?, last_totp_counter = ?, updated_at = ? WHERE id = ?',
      confirmedAt, counter, confirmedAt, user.id,
    );
    return publicUser({ ...user, mfaConfirmedAt: confirmedAt, lastTotpCounter: counter, updatedAt: confirmedAt });
  }

  async approveUser(admin, userId) {
    const user = await this.mustFindUser(userId);
    if (user.status === 'active') return publicUser(user);
    if (user.status === 'suspended') fail('ACCOUNT_SUSPENDED', 'A suspended account must be reinstated by an admin first.', 409);
    if (!user.mfaConfirmedAt) fail('MFA_REQUIRED', 'The account must confirm MFA before it can be approved.', 409);
    const approvedAt = nowIso();
    await this.run('UPDATE users SET status = ?, approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ?', 'active', admin.id, approvedAt, approvedAt, user.id);
    await this.audit(admin, 'user.approved', 'user', user.id, {});
    return publicUser({ ...user, status: 'active', approvedBy: admin.id, approvedAt, updatedAt: approvedAt });
  }

  async suspendUser(admin, userId) {
    const user = await this.mustFindUser(userId);
    const updatedAt = nowIso();
    await this.run('UPDATE users SET status = ?, updated_at = ? WHERE id = ?', 'suspended', updatedAt, user.id);
    const sessions = await this.all('SELECT id FROM sessions WHERE user_id = ? AND revoked_at IS NULL', user.id);
    for (const session of sessions) await this.revokeSession(session.id);
    await this.audit(admin, 'user.suspended', 'user', user.id, {});
    return publicUser({ ...user, status: 'suspended', updatedAt });
  }

  async verifyCredentials(email, password) {
    const user = await this.getUserByEmail(email || '');
    if (!user) return null;
    if (!(await verifyPassword(password, user.passwordHash))) return null;
    return user;
  }

  async verifyLoginMfa(userId, code, { at } = {}) {
    const user = await this.mustFindUser(userId);
    if (!user.totpSecret || !user.mfaConfirmedAt) fail('MFA_REQUIRED', 'This account has not completed MFA enrollment.', 401);
    const counter = await verifyTotp(user.totpSecret, code, { at });
    if (counter === -1 || counter <= user.lastTotpCounter) {
      fail('MFA_INVALID_CODE', 'That authenticator code is not valid or was already used.', 401);
    }
    await this.run('UPDATE users SET last_totp_counter = ? WHERE id = ?', counter, user.id);
    return { ...user, lastTotpCounter: counter };
  }

  // --- Sessions --------------------------------------------------------------
  async createSession(user) {
    const secret = this.requireSessionSecret();
    const now = Date.now();
    const session = {
      id: newId('ses'), userId: user.id, createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + SESSION_TTL_MS).toISOString(), revokedAt: null,
    };
    await this.run('INSERT INTO sessions (id, user_id, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?)', session.id, session.userId, session.createdAt, session.expiresAt, session.revokedAt);
    const payload = bytesToBase64Url(encoder.encode(JSON.stringify({ sid: session.id, sub: user.id, exp: now + SESSION_TTL_MS })));
    const signature = await hmacSha256(secret, payload);
    return { token: `${payload}.${signature}`, session };
  }

  async verifySessionToken(token) {
    if (!token || typeof token !== 'string') return null;
    const [payload, signature] = token.split('.');
    if (!payload || !signature) return null;
    let expected;
    try { expected = await hmacSha256(this.requireSessionSecret(), payload); } catch { return null; }
    if (!timingSafeEqual(encoder.encode(signature), encoder.encode(expected))) return null;
    let claims;
    try { claims = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload))); } catch { return null; }
    if (!claims.sid || !claims.sub || Date.now() > Number(claims.exp)) return null;
    const row = await this.first('SELECT * FROM sessions WHERE id = ?', claims.sid);
    if (!row || row.revoked_at || row.user_id !== claims.sub) return null;
    if (Date.now() > Date.parse(row.expires_at)) return null;
    return { id: row.id, userId: row.user_id, createdAt: row.created_at, expiresAt: row.expires_at, revokedAt: row.revoked_at };
  }

  async revokeSession(sessionId) {
    const revokedAt = nowIso();
    await this.run('UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?', revokedAt, sessionId);
    return this.first('SELECT * FROM sessions WHERE id = ?', sessionId);
  }

  async login(email, password, totpCode, { at } = {}) {
    const user = await this.verifyCredentials(email, password);
    if (!user) fail('INVALID_CREDENTIALS', 'Email or password is incorrect.', 401);
    if (user.status === 'suspended') fail('ACCOUNT_SUSPENDED', 'This account has been suspended. Contact an administrator.', 403);
    await this.verifyLoginMfa(user.id, totpCode, { at });
    const { token, session } = await this.createSession(user);
    await this.audit(user, 'user.login', 'user', user.id, { sessionId: session.id });
    return { token, session, user: publicUser(user) };
  }

  async logout(sessionId) { return this.revokeSession(sessionId); }

  // --- Authorization helpers --------------------------------------------------
  requireAuthenticated(user) {
    if (!user) fail('UNAUTHENTICATED', 'You must be signed in.', 401);
    return user;
  }

  requireActiveAccount(user) {
    this.requireAuthenticated(user);
    if (user.status === 'suspended') fail('ACCOUNT_SUSPENDED', 'This account has been suspended. Contact an administrator.', 403);
    if (user.status !== 'active') fail('ACCOUNT_NOT_ACTIVE', 'This account is not active yet. It must complete verification and be approved first.', 403);
    return user;
  }

  requireRole(user, ...roles) {
    this.requireAuthenticated(user);
    if (!roles.includes(user.role)) fail('FORBIDDEN', `This action requires one of: ${roles.join(', ')}.`, 403);
    return user;
  }

  // --- Research submissions -----------------------------------------------------
  async submissionHistory(submissionId) {
    const rows = await this.all('SELECT * FROM submission_versions WHERE submission_id = ? ORDER BY version ASC', submissionId);
    return rows.map((row) => ({
      version: row.version, editedAt: row.edited_at, status: row.status,
      title: row.title, summary: row.summary, biomarkers: parseJson(row.biomarkers_json, []),
      cancerType: row.cancer_type, sourceUrl: row.source_url,
    }));
  }

  async submissionWithHistory(row) {
    if (!row) return null;
    return submissionFromRow(row, await this.submissionHistory(row.id));
  }

  async mustFindSubmission(id) {
    const row = await this.first('SELECT * FROM submissions WHERE id = ? AND deleted_at IS NULL', id);
    if (!row) fail('SUBMISSION_NOT_FOUND', 'Submission not found.', 404);
    return this.submissionWithHistory(row);
  }

  assertSubmissionOwnerOrAdmin(actor, submission) {
    if (actor.role !== 'admin' && submission.submittedBy !== actor.id) {
      fail('FORBIDDEN', 'You can only modify your own submissions.', 403);
    }
  }

  async createSubmission(actor, content = {}) {
    this.requireActiveAccount(actor);
    this.requireRole(actor, 'doctor', 'admin');
    validateSubmissionContent(content);
    const createdAt = nowIso();
    const submission = {
      id: newId('sub'), submittedBy: actor.id, submitterEmail: actor.email,
      title: content.title.trim(), summary: content.summary.trim(),
      biomarkers: content.biomarkers.map((b) => b.trim()), cancerType: content.cancerType.trim(),
      sourceUrl: content.sourceUrl || null, status: 'pending_review', version: 1, history: [],
      reviewNote: null, reviewedBy: null, reviewedAt: null, createdAt, updatedAt: createdAt,
      deletedAt: null, deletedBy: null,
    };
    await this.run(
      `INSERT INTO submissions (id, submitted_by, submitter_email, title, summary, biomarkers_json, cancer_type,
        source_url, status, version, review_note, reviewed_by, reviewed_at, created_at, updated_at, deleted_at, deleted_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      submission.id, submission.submittedBy, submission.submitterEmail, submission.title, submission.summary,
      JSON.stringify(submission.biomarkers), submission.cancerType, submission.sourceUrl, submission.status,
      submission.version, submission.reviewNote, submission.reviewedBy, submission.reviewedAt,
      submission.createdAt, submission.updatedAt, submission.deletedAt, submission.deletedBy,
    );
    await this.audit(actor, 'submission.created', 'submission', submission.id, { version: 1 });
    return submission;
  }

  async editSubmission(actor, id, content = {}) {
    this.requireActiveAccount(actor);
    const submission = await this.mustFindSubmission(id);
    this.assertSubmissionOwnerOrAdmin(actor, submission);
    const next = {
      title: submission.title, summary: submission.summary, biomarkers: submission.biomarkers,
      cancerType: submission.cancerType, sourceUrl: submission.sourceUrl, ...content,
    };
    validateSubmissionContent(next);
    await this.run(
      `INSERT INTO submission_versions (id, submission_id, version, title, summary, biomarkers_json, cancer_type, source_url, status, edited_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newId('ver'), submission.id, submission.version, submission.title, submission.summary,
      JSON.stringify(submission.biomarkers), submission.cancerType, submission.sourceUrl, submission.status, submission.updatedAt,
    );
    const updatedAt = nowIso();
    const resetReview = submission.status !== 'pending_review';
    await this.run(
      `UPDATE submissions SET title = ?, summary = ?, biomarkers_json = ?, cancer_type = ?, source_url = ?,
        version = version + 1, status = 'pending_review',
        review_note = CASE WHEN ? THEN NULL ELSE review_note END,
        reviewed_by = CASE WHEN ? THEN NULL ELSE reviewed_by END,
        reviewed_at = CASE WHEN ? THEN NULL ELSE reviewed_at END,
        updated_at = ? WHERE id = ?`,
      next.title.trim(), next.summary.trim(), JSON.stringify(next.biomarkers.map((b) => b.trim())),
      next.cancerType.trim(), next.sourceUrl || null, resetReview ? 1 : 0, resetReview ? 1 : 0, resetReview ? 1 : 0,
      updatedAt, submission.id,
    );
    await this.audit(actor, 'submission.edited', 'submission', submission.id, { version: submission.version + 1 });
    return this.mustFindSubmission(id);
  }

  async reviewSubmission(actor, id, note, decision) {
    this.requireActiveAccount(actor);
    this.requireRole(actor, 'reviewer', 'admin');
    const submission = await this.mustFindSubmission(id);
    if (submission.submittedBy === actor.id) fail('SELF_REVIEW_FORBIDDEN', 'You cannot review your own submission.', 403);
    if (submission.status !== 'pending_review') fail('NOT_PENDING_REVIEW', 'Only submissions awaiting review can be reviewed.', 409);
    if (decision === 'rejected' && (!note || String(note).trim() === '')) {
      fail('REVIEW_NOTE_REQUIRED', 'Rejecting a submission requires a note explaining why.');
    }
    const reviewedAt = nowIso();
    await this.run(
      'UPDATE submissions SET status = ?, review_note = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ?',
      decision, note ? String(note) : null, actor.id, reviewedAt, reviewedAt, id,
    );
    await this.audit(actor, `submission.${decision}`, 'submission', id, { note: note ? String(note) : null });
    return this.mustFindSubmission(id);
  }

  async deleteSubmission(actor, id) {
    this.requireActiveAccount(actor);
    const submission = await this.mustFindSubmission(id);
    this.assertSubmissionOwnerOrAdmin(actor, submission);
    const deletedAt = nowIso();
    await this.run('UPDATE submissions SET deleted_at = ?, deleted_by = ?, updated_at = ? WHERE id = ?', deletedAt, actor.id, deletedAt, id);
    await this.audit(actor, 'submission.deleted', 'submission', id, {});
    return { ...submission, deletedAt, deletedBy: actor.id, updatedAt: deletedAt };
  }

  async getSubmission(actor, id) {
    this.requireActiveAccount(actor);
    const submission = await this.mustFindSubmission(id);
    if (actor.role === 'doctor' && submission.submittedBy !== actor.id) {
      fail('FORBIDDEN', 'Doctors can only view their own submissions.', 403);
    }
    return submission;
  }

  async listMine(actor) {
    this.requireActiveAccount(actor);
    const rows = await this.all('SELECT * FROM submissions WHERE submitted_by = ? AND deleted_at IS NULL ORDER BY created_at DESC', actor.id);
    const result = [];
    for (const row of rows) result.push(await this.submissionWithHistory(row));
    return result;
  }

  async listPendingReview(actor) {
    this.requireActiveAccount(actor);
    this.requireRole(actor, 'reviewer', 'admin');
    const rows = await this.all("SELECT * FROM submissions WHERE status = 'pending_review' AND deleted_at IS NULL ORDER BY created_at ASC");
    const result = [];
    for (const row of rows) result.push(await this.submissionWithHistory(row));
    return result;
  }

  async listApprovedSubmissions() {
    const rows = await this.all("SELECT * FROM submissions WHERE status = 'approved' AND deleted_at IS NULL ORDER BY reviewed_at DESC");
    const result = [];
    for (const row of rows) result.push(await this.submissionWithHistory(row));
    return result;
  }

  // --- Clinician matcher cases --------------------------------------------------
  caseFromRow(row) {
    if (!row) return null;
    return {
      id: row.id, label: row.label, cancerType: row.cancer_type, stage: row.stage,
      histology: row.histology, sampleType: row.sample_type, priorTherapy: row.prior_therapy,
      status: row.status, created_at: row.created_at,
      uploadCount: Number(row.upload_count || 0), matchCount: Number(row.match_count || 0),
    };
  }

  async mustFindCase(actor, id) {
    const numericId = Number(id);
    if (!Number.isInteger(numericId) || numericId <= 0) fail('CASE_NOT_FOUND', 'Case not found.', 404);
    const row = await this.first('SELECT * FROM matcher_cases WHERE id = ? AND deleted_at IS NULL', numericId);
    if (!row) fail('CASE_NOT_FOUND', 'Case not found.', 404);
    if (actor.role !== 'admin' && row.owner_user_id !== actor.id) fail('FORBIDDEN', 'You can only access your own cases.', 403);
    return row;
  }

  async listCases(actor, { limit = 50 } = {}) {
    this.requireActiveAccount(actor);
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 50));
    const ownerClause = actor.role === 'admin' ? '' : 'AND c.owner_user_id = ?';
    const params = actor.role === 'admin' ? [] : [actor.id];
    const rows = await this.all(
      `SELECT c.*,
        (SELECT COUNT(*) FROM matcher_uploads u WHERE u.case_id = c.id) AS upload_count,
        (SELECT COUNT(*) FROM matcher_matches m WHERE m.case_id = c.id) AS match_count
       FROM matcher_cases c WHERE c.deleted_at IS NULL ${ownerClause}
       ORDER BY c.id DESC LIMIT ?`,
      ...params, safeLimit,
    );
    const cases = rows.map((row) => this.caseFromRow(row));
    const totals = await this.first(
      `SELECT
        (SELECT COUNT(*) FROM matcher_uploads u JOIN matcher_cases c ON c.id = u.case_id WHERE c.deleted_at IS NULL ${actor.role === 'admin' ? '' : 'AND c.owner_user_id = ?'}) AS uploads,
        (SELECT COUNT(*) FROM matcher_matches m JOIN matcher_cases c ON c.id = m.case_id WHERE c.deleted_at IS NULL ${actor.role === 'admin' ? '' : 'AND c.owner_user_id = ?'}) AS matches,
        (SELECT COUNT(*) FROM matcher_matches m JOIN matcher_cases c ON c.id = m.case_id WHERE c.deleted_at IS NULL AND m.score_value > 50 ${actor.role === 'admin' ? '' : 'AND c.owner_user_id = ?'}) AS actionable`,
      ...(actor.role === 'admin' ? [] : [actor.id, actor.id, actor.id]),
    );
    return {
      cases,
      stats: {
        totalCases: cases.length, totalUploads: Number(totals?.uploads || 0),
        totalMatches: Number(totals?.matches || 0), actionable: Number(totals?.actionable || 0),
      },
    };
  }

  async createCase(actor, input = {}) {
    this.requireActiveAccount(actor);
    const label = String(input.label || '').trim();
    const cancerType = String(input.cancerType || '').trim();
    if (!label || label.length > 120) fail('CASE_INVALID', 'A case needs a de-identified label of at most 120 characters.');
    if (!cancerType) fail('CASE_INVALID', 'A case must name a cancer type.');
    const createdAt = nowIso();
    const result = await this.run(
      `INSERT INTO matcher_cases (owner_user_id, label, cancer_type, stage, histology, sample_type, prior_therapy, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'intake', ?, ?)`,
      actor.id, label, cancerType, String(input.stage || 'Stage IV'), String(input.histology || ''),
      String(input.sampleType || 'Tissue NGS'), String(input.priorTherapy || ''), createdAt, createdAt,
    );
    const id = Number(result.meta?.last_row_id);
    await this.audit(actor, 'case.created', 'matcher_case', String(id), { cancerType });
    return { id };
  }

  async deleteCase(actor, id) {
    this.requireActiveAccount(actor);
    const row = await this.mustFindCase(actor, id);
    const deletedAt = nowIso();
    await this.run('UPDATE matcher_cases SET deleted_at = ?, updated_at = ? WHERE id = ?', deletedAt, deletedAt, row.id);
    await this.audit(actor, 'case.deleted', 'matcher_case', String(row.id), {});
    return { ok: true };
  }

  async replaceCaseMatches(caseId, results) {
    await this.run('DELETE FROM matcher_matches WHERE case_id = ?', caseId);
    const createdAt = nowIso();
    for (const result of results) {
      await this.run(
        `INSERT INTO matcher_matches (case_id, trial_id, trial_name, required_biomarkers_json, matched_biomarkers_json, match_score, score_value, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        caseId, result.trialId, result.trialName, JSON.stringify(result.requiredBiomarkers),
        JSON.stringify(result.matchedBiomarkers), result.matchScore, result.scoreValue, result.status, createdAt,
      );
    }
  }

  async getCaseDetail(actor, caseId) {
    this.requireActiveAccount(actor);
    const row = await this.mustFindCase(actor, caseId);
    const uploadRows = await this.all('SELECT * FROM matcher_uploads WHERE case_id = ? ORDER BY id DESC', row.id);
    const matchRows = await this.all('SELECT * FROM matcher_matches WHERE case_id = ? ORDER BY score_value DESC', row.id);
    return {
      uploads: uploadRows.map((upload) => ({
        id: upload.id, fileName: upload.file_name, fileKind: upload.file_kind,
        sizeKb: Math.max(0, Math.round(upload.size_bytes / 1024)), biomarkers: parseJson(upload.biomarkers_json, []),
        created_at: upload.created_at,
      })),
      matches: matchRows.map((match) => {
        const required = parseJson(match.required_biomarkers_json, []);
        const matched = parseJson(match.matched_biomarkers_json, []);
        const score = Number(match.score_value);
        return {
          id: match.id,
          gene: matched.length ? matched.join(', ') : 'No matched biomarker',
          variant: match.trial_id,
          alteration: `Trial criteria: ${required.join(', ') || 'none'}`,
          vaf: 0,
          classification: match.status === 'POTENTIAL_MATCH' ? 'Potential match' : 'Low match',
          therapy: match.trial_name,
          evidenceLevel: match.match_score,
          trialCount: 1,
          confidence: score,
          status: match.status,
          rationale: matched.length
            ? `The uploaded biomarker list matched ${matched.join(', ')} from this trial's required criteria (${required.join(', ')}).`
            : `The uploaded biomarker list matched none of this trial's required criteria (${required.join(', ')}).`,
        };
      }),
    };
  }

  async uploadCaseFile(actor, caseId, file) {
    this.requireActiveAccount(actor);
    const row = await this.mustFindCase(actor, caseId);
    if (!file) fail('UPLOAD_REQUIRED', 'Choose a research file to upload.');
    const buffer = new Uint8Array(await file.arrayBuffer());
    const analysis = await this.analyzeFile({ originalname: file.name, buffer });
    const extension = extensionOf(file.name);
    const fileKind = extension === '.json' ? 'JSON biomarker list' : extension === '.csv' ? 'CSV biomarker list' : extension === '.tsv' ? 'TSV biomarker list' : 'Text biomarker list';
    const createdAt = nowIso();
    const result = await this.run(
      `INSERT INTO matcher_uploads (case_id, file_name, file_kind, size_bytes, biomarkers_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      row.id, String(file.name || 'biomarkers.txt'), fileKind, buffer.byteLength, JSON.stringify(analysis.biomarkers), createdAt,
    );
    await this.replaceCaseMatches(row.id, analysis.results);
    await this.run("UPDATE matcher_cases SET status = 'matched', updated_at = ? WHERE id = ?", createdAt, row.id);
    await this.audit(actor, 'case.upload_analyzed', 'matcher_case', String(row.id), { fileName: String(file.name || ''), biomarkers: analysis.biomarkers });
    return { id: Number(result.meta?.last_row_id), biomarkers: analysis.biomarkers, results: analysis.results };
  }

  async runCaseMatch(actor, caseId) {
    this.requireActiveAccount(actor);
    const row = await this.mustFindCase(actor, caseId);
    const uploadRows = await this.all('SELECT biomarkers_json FROM matcher_uploads WHERE case_id = ? ORDER BY id ASC', row.id);
    const biomarkers = [...new Set(uploadRows.flatMap((upload) => parseJson(upload.biomarkers_json, [])))];
    if (!biomarkers.length) fail('CASE_MATCH_INPUT_MISSING', 'Upload a biomarker list before running a match.');
    const results = this.engine.match(biomarkers, await this.getTrials());
    await this.replaceCaseMatches(row.id, results);
    await this.run("UPDATE matcher_cases SET status = 'matched', updated_at = ? WHERE id = ?", nowIso(), row.id);
    await this.audit(actor, 'case.match_run', 'matcher_case', String(row.id), { biomarkers });
    return { count: results.length, ok: true };
  }

  async deleteUpload(actor, uploadId) {
    this.requireActiveAccount(actor);
    const upload = await this.first('SELECT * FROM matcher_uploads WHERE id = ?', Number(uploadId));
    if (!upload) fail('UPLOAD_NOT_FOUND', 'Upload not found.', 404);
    await this.mustFindCase(actor, upload.case_id);
    await this.run('DELETE FROM matcher_uploads WHERE id = ?', upload.id);
    const remaining = await this.all('SELECT biomarkers_json FROM matcher_uploads WHERE case_id = ? ORDER BY id ASC', upload.case_id);
    const biomarkers = [...new Set(remaining.flatMap((row) => parseJson(row.biomarkers_json, [])))];
    if (biomarkers.length) {
      await this.replaceCaseMatches(upload.case_id, this.engine.match(biomarkers, await this.getTrials()));
    } else {
      await this.run('DELETE FROM matcher_matches WHERE case_id = ?', upload.case_id);
      await this.run("UPDATE matcher_cases SET status = 'intake', updated_at = ? WHERE id = ?", nowIso(), upload.case_id);
    }
    await this.audit(actor, 'case.upload_deleted', 'matcher_case', String(upload.case_id), { uploadId: upload.id });
    return { ok: true };
  }
}
