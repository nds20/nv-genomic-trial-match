'use strict';

const { scrypt, randomBytes, randomUUID, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const { newId } = require('./store');
const { fail } = require('./errors');
const { generateSecret, otpauthUri, verifyTotp } = require('./totp');
const { lookupNpi } = require('./npi');
const { isValidRole } = require('./roles');

const scryptAsync = promisify(scrypt);
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };
const ISSUER = process.env.AUTH_ISSUER || 'Biometric Screening Research';
const STATE_CODE = /^[A-Z]{2}$/;

async function hashPassword(password) {
    if (typeof password !== 'string' || password.length < 12) {
        fail('WEAK_PASSWORD', 'Password must be at least 12 characters.');
    }
    const salt = randomBytes(16);
    const derived = await scryptAsync(password, salt, SCRYPT_PARAMS.keylen, {
        N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p,
    });
    return ['scrypt', SCRYPT_PARAMS.N, SCRYPT_PARAMS.r, SCRYPT_PARAMS.p,
        salt.toString('base64'), derived.toString('base64')].join('$');
}

async function verifyPassword(password, stored) {
    try {
        const [scheme, n, r, p, saltB64, hashB64] = String(stored).split('$');
        if (scheme !== 'scrypt') return false;
        const expected = Buffer.from(hashB64, 'base64');
        const derived = await scryptAsync(String(password), Buffer.from(saltB64, 'base64'), expected.length, {
            N: Number(n), r: Number(r), p: Number(p),
        });
        return timingSafeEqual(expected, derived);
    } catch {
        return false;
    }
}

// What leaves the service: never the password hash or TOTP secret.
function publicUser(user) {
    if (!user) return null;
    const { passwordHash, totpSecret, ...rest } = user;
    return { ...rest, mfaEnrolled: Boolean(totpSecret) };
}

class UserService {
    // `audit` is optional: when wired (see index.js) lifecycle transitions
    // are recorded in the audit log.
    constructor(store, { inviteService, npiLookup = lookupNpi, audit = null } = {}) {
        this.store = store;
        this.invites = inviteService;
        this.npiLookup = npiLookup;
        this.audit = audit;
    }

    async #byEmail(email) {
        const [user] = await this.store.find('users', u => u.email === String(email).toLowerCase());
        return user;
    }

    async getById(id) {
        return this.store.get('users', id);
    }

    // The one and only account-creation path: a valid invite is mandatory.
    async register({ inviteToken, name, email, password, npi, licenseNumber, licenseState, role } = {}) {
        if (!this.invites) fail('INVITES_NOT_CONFIGURED', 'Registration is not configured.', 500);
        if (!name || !email || !npi || !licenseNumber || !licenseState) {
            fail('REGISTRATION_INCOMPLETE', 'Name, email, NPI, license number and license state are all required.');
        }
        const inviteInfo = await this.invites.peekInvite(inviteToken); // throws if invalid/used/expired
        const normalizedEmail = String(email).toLowerCase();
        if (inviteInfo.email && inviteInfo.email !== normalizedEmail) {
            fail('INVITE_EMAIL_MISMATCH', 'This invitation was issued to a different email address.', 403);
        }
        if (await this.#byEmail(normalizedEmail)) {
            fail('EMAIL_TAKEN', 'An account with this email already exists.', 409);
        }
        const [npiTaken] = await this.store.find('users', u => u.npi === String(npi));
        if (npiTaken) fail('NPI_TAKEN', 'An account with this NPI already exists.', 409);
        const assignedRole = role || inviteInfo.role || 'doctor';
        if (!isValidRole(assignedRole)) fail('INVALID_ROLE', `Unknown role: ${assignedRole}`);
        if (!STATE_CODE.test(String(licenseState).toUpperCase())) {
            fail('INVALID_LICENSE_STATE', 'License state must be a 2-letter state code.');
        }

        const npiResult = await this.npiLookup(String(npi), { suppliedName: name });
        if (npiResult.status === 'invalid' || npiResult.status === 'not_found' || npiResult.status === 'mismatch') {
            fail('NPI_VERIFICATION_FAILED', `We could not verify this NPI: ${npiResult.detail}`, 422);
        }

        const now = new Date().toISOString();
        const user = {
            id: newId('usr'),
            name: String(name),
            email: normalizedEmail,
            passwordHash: await hashPassword(password),
            npi: String(npi),
            licenseNumber: String(licenseNumber),
            licenseState: String(licenseState).toUpperCase(),
            role: assignedRole,
            status: 'pending',
            npiVerification: npiResult.status, // "verified" | "manual_review"
            npiVerificationDetail: npiResult.detail,
            totpSecret: null,
            mfaConfirmedAt: null,
            lastTotpCounter: -1,
            approvedBy: null,
            approvedAt: null,
            createdAt: now,
            updatedAt: now,
        };
        await this.store.put('users', user.id, user);
        await this.invites.consumeInvite(inviteToken, user.id);
        if (this.audit) {
            await this.audit.record({
                actorId: user.id, actorRole: user.role, action: 'user.registered',
                entityType: 'user', entityId: user.id,
                details: { email: user.email, npiVerification: npiResult.status },
            });
        }
        return publicUser(user);
    }

    // --- MFA -------------------------------------------------------------
    // Enrollment only issues a secret; the account becomes MFA-confirmed
    // after the user proves possession with a valid code (confirmMfa).
    async beginMfaEnrollment(userId) {
        const user = await this.#mustFind(userId);
        user.totpSecret = generateSecret();
        user.mfaConfirmedAt = null;
        user.updatedAt = new Date().toISOString();
        await this.store.put('users', user.id, user);
        return {
            secret: user.totpSecret,
            otpauthUri: otpauthUri({ issuer: ISSUER, account: user.email, secret: user.totpSecret }),
        };
    }

    async confirmMfa(userId, code, { at } = {}) {
        const user = await this.#mustFind(userId);
        if (!user.totpSecret) fail('MFA_NOT_ENROLLED', 'MFA enrollment has not been started.');
        const counter = verifyTotp(user.totpSecret, code, { at });
        if (counter === -1) fail('MFA_INVALID_CODE', 'That authenticator code is not valid.', 401);
        user.mfaConfirmedAt = new Date().toISOString();
        user.lastTotpCounter = counter;
        user.updatedAt = user.mfaConfirmedAt;
        await this.store.put('users', user.id, user);
        return publicUser(user);
    }

    async #mustFind(userId) {
        const user = await this.store.get('users', userId);
        if (!user) fail('USER_NOT_FOUND', 'User not found.', 404);
        return user;
    }

    // --- Admin approval ----------------------------------------------------
    // MFA is mandatory BEFORE activation: approval refuses accounts that
    // have not confirmed an authenticator.
    async approveUser(admin, userId) {
        const user = await this.#mustFind(userId);
        if (user.status === 'active') return publicUser(user);
        if (user.status === 'suspended') fail('ACCOUNT_SUSPENDED', 'A suspended account must be reinstated by an admin first.', 409);
        if (!user.mfaConfirmedAt) {
            fail('MFA_REQUIRED', 'The account must confirm MFA before it can be approved.', 409);
        }
        user.status = 'active';
        user.approvedBy = admin.id;
        user.approvedAt = new Date().toISOString();
        user.updatedAt = user.approvedAt;
        await this.store.put('users', user.id, user);
        if (this.audit) {
            await this.audit.record({
                actorId: admin.id, actorRole: admin.role, action: 'user.approved',
                entityType: 'user', entityId: user.id, details: {},
            });
        }
        return publicUser(user);
    }

    async suspendUser(admin, userId) {
        const user = await this.#mustFind(userId);
        user.status = 'suspended';
        user.updatedAt = new Date().toISOString();
        await this.store.put('users', user.id, user);
        if (this.audit) {
            await this.audit.record({
                actorId: admin.id, actorRole: admin.role, action: 'user.suspended',
                entityType: 'user', entityId: user.id, details: {},
            });
        }
        return publicUser(user);
    }

    // --- Login ---------------------------------------------------------------
    // Verifies password + (once enrolled) a TOTP code. A valid login for a
    // pending account succeeds but the returned user is still flagged
    // pending — route guards (requireActiveAccount) block real work.
    async verifyCredentials(email, password) {
        const user = await this.#byEmail(email || '');
        if (!user) return null;
        if (!(await verifyPassword(password, user.passwordHash))) return null;
        return user;
    }

    // Second factor check with replay protection: each TOTP step can be
    // used for exactly one login.
    async verifyLoginMfa(userId, code, { at } = {}) {
        const user = await this.#mustFind(userId);
        if (!user.totpSecret || !user.mfaConfirmedAt) {
            fail('MFA_REQUIRED', 'This account has not completed MFA enrollment.', 401);
        }
        const counter = verifyTotp(user.totpSecret, code, { at });
        if (counter === -1 || counter <= user.lastTotpCounter) {
            fail('MFA_INVALID_CODE', 'That authenticator code is not valid or was already used.', 401);
        }
        user.lastTotpCounter = counter;
        await this.store.put('users', user.id, user);
        return user;
    }
}

module.exports = { UserService, hashPassword, verifyPassword, publicUser };
