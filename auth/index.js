'use strict';

// Doctor login + research submission flow for the precision-oncology
// platform (biometricscreeningresearch.net).
//
//   const { createAuthService, MemoryStore } = require('./auth');
//   const auth = createAuthService(); // JSON-file store by default
//
// Design summary (see auth/README.md for the full document):
//   * No public sign-up. An admin issues a single-use, expiring invite;
//     registration is impossible without one.
//   * Registrants provide an NPI + state license. The NPI is validated
//     locally (Luhn) and against the public NPPES registry; lookups that
//     fail degrade to manual review, never to approval.
//   * Passwords are scrypt-hashed; MFA (TOTP) enrollment + confirmation is
//     mandatory before an admin can activate an account.
//   * Roles: doctor submits, reviewer approves into the live dataset,
//     admin manages invites and accounts.
//   * Submissions land in `pending_review`, edits version instead of
//     overwriting, deletes are soft, and every mutation hits an
//     append-only audit log.

const path = require('node:path');
const { MemoryStore, JsonFileStore } = require('./store');
const { InviteService } = require('./invites');
const { UserService, publicUser } = require('./users');
const { SessionService } = require('./session');
const { SubmissionService, AuditLog } = require('./submissions');
const roles = require('./roles');
const { lookupNpi, validateNpiFormat } = require('./npi');
const totp = require('./totp');

function createAuthService({ store, sessionSecret, inviteTtlHours, npiLookup } = {}) {
    const dataStore = store || new JsonFileStore(
        process.env.AUTH_STORE_FILE || path.join(__dirname, '..', 'data', 'auth-store.json'),
    );
    const audit = new AuditLog(dataStore);
    const invites = new InviteService(dataStore, { ttlHours: inviteTtlHours });
    const users = new UserService(dataStore, {
        inviteService: invites,
        npiLookup: npiLookup || lookupNpi,
        audit,
    });
    const sessions = new SessionService(dataStore, { secret: sessionSecret });
    const submissions = new SubmissionService(dataStore, { audit });

    return {
        store: dataStore,
        audit,
        invites,
        users,
        sessions,
        submissions,

        // Convenience: full login = password check, then TOTP, then token.
        // Throws AuthError on any failure; returns { token, session, user }.
        async login(email, password, totpCode, { at } = {}) {
            const user = await users.verifyCredentials(email, password);
            if (!user) {
                const { fail } = require('./errors');
                fail('INVALID_CREDENTIALS', 'Email or password is incorrect.', 401);
            }
            if (user.status === 'suspended') {
                const { fail } = require('./errors');
                fail('ACCOUNT_SUSPENDED', 'This account has been suspended. Contact an administrator.', 403);
            }
            await users.verifyLoginMfa(user.id, totpCode, { at });
            const { token, session } = await sessions.createSession(user);
            await audit.record({
                actorId: user.id, actorRole: user.role, action: 'user.login',
                entityType: 'user', entityId: user.id, details: { sessionId: session.id },
            });
            return { token, session, user: publicUser(user) };
        },

        async logout(sessionId) {
            return sessions.revokeSession(sessionId);
        },

        // (req) => user|null resolver for roles.authenticate()/requireSession.
        resolveSessionUser(req) {
            const { createSessionResolver } = require('./session');
            return createSessionResolver(sessions, users)(req);
        },
    };
}

module.exports = {
    createAuthService,
    MemoryStore,
    JsonFileStore,
    InviteService,
    UserService,
    SessionService,
    SubmissionService,
    AuditLog,
    roles,
    lookupNpi,
    validateNpiFormat,
    totp,
    publicUser,
};
