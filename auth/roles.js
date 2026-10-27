'use strict';

// Role definitions and guard helpers.
//
// Roles:
//   doctor   — submits research, manages own submissions.
//   reviewer — approves/rejects submissions into the live dataset.
//   admin    — issues invites, approves/suspends accounts, everything a
//              reviewer can do.
//
// The guards are framework-agnostic: each takes a user record (or null) and
// throws an AuthError the HTTP layer maps to 401/403. `authenticate` builds
// an Express-style middleware factory out of any "resolve session" function
// so server.js can write: app.use('/api/submissions', authenticate(...), ...)

const { fail } = require('./errors');

const ROLES = ['doctor', 'reviewer', 'admin'];

function isValidRole(role) {
    return ROLES.includes(role);
}

function requireAuthenticated(user) {
    if (!user) fail('UNAUTHENTICATED', 'You must be signed in.', 401);
    return user;
}

function requireActiveAccount(user) {
    requireAuthenticated(user);
    if (user.status === 'suspended') {
        fail('ACCOUNT_SUSPENDED', 'This account has been suspended. Contact an administrator.', 403);
    }
    if (user.status !== 'active') {
        fail('ACCOUNT_NOT_ACTIVE', 'This account is not active yet. It must complete verification and be approved first.', 403);
    }
    return user;
}

function requireRole(user, ...roles) {
    requireAuthenticated(user);
    if (!roles.includes(user.role)) {
        fail('FORBIDDEN', `This action requires one of: ${roles.join(', ')}.`, 403);
    }
    return user;
}

// resolveSession: async (req) => user | null
function authenticate(resolveSession, { active = true } = {}) {
    return async (req, res, next) => {
        try {
            const user = await resolveSession(req);
            if (active) requireActiveAccount(user);
            else requireAuthenticated(user);
            req.user = user;
            next();
        } catch (error) {
            next(error);
        }
    };
}

function authorize(...roles) {
    return (req, res, next) => {
        try {
            requireRole(req.user, ...roles);
            next();
        } catch (error) {
            next(error);
        }
    };
}

module.exports = {
    ROLES,
    isValidRole,
    requireAuthenticated,
    requireActiveAccount,
    requireRole,
    authenticate,
    authorize,
};
