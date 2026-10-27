'use strict';

const { createHmac, randomUUID, timingSafeEqual } = require('node:crypto');
const { fail } = require('./errors');

// Signed, expiring session tokens for the prototype: a compact
// "payload.signature" pair where the payload is base64url JSON carrying the
// session id, user id and expiry, and the signature is HMAC-SHA256 keyed by
// SESSION_SECRET. Sessions are also recorded in the store so they can be
// revoked (logout, suspension) before they expire.
//
// The token is designed to travel in an httpOnly cookie — see
// sessionCookie()/clearSessionCookie(). Nothing in this module ever puts
// the token in a URL or localStorage-friendly response body by itself; the
// HTTP layer decides how to deliver it.

const COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'bsr_session';
const DEFAULT_TTL_MINUTES = 12 * 60; // 12 hours

function resolveSecret(secret) {
    const value = secret ?? process.env.SESSION_SECRET;
    if (!value || String(value).length < 16) {
        fail('SESSION_SECRET_MISSING', 'SESSION_SECRET must be set to at least 16 characters.', 500);
    }
    return String(value);
}

function sign(payloadB64, secret) {
    return createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

class SessionService {
    constructor(store, { secret, ttlMinutes = DEFAULT_TTL_MINUTES } = {}) {
        this.store = store;
        this.secret = resolveSecret(secret);
        this.ttlMs = ttlMinutes * 60 * 1000;
    }

    async createSession(user) {
        const now = Date.now();
        const session = {
            id: `ses_${randomUUID()}`,
            userId: user.id,
            createdAt: new Date(now).toISOString(),
            expiresAt: new Date(now + this.ttlMs).toISOString(),
            revokedAt: null,
        };
        await this.store.put('sessions', session.id, session);
        const payload = Buffer.from(JSON.stringify({
            sid: session.id, sub: user.id, exp: now + this.ttlMs,
        })).toString('base64url');
        return { token: `${payload}.${sign(payload, this.secret)}`, session };
    }

    // Returns the session record or null for any invalid/expired/revoked
    // token. Never throws on bad input — bad tokens are a normal event.
    async verifySessionToken(token) {
        if (!token || typeof token !== 'string') return null;
        const [payload, signature] = token.split('.');
        if (!payload || !signature) return null;
        const expected = sign(payload, this.secret);
        const a = Buffer.from(signature);
        const b = Buffer.from(expected);
        if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
        let claims;
        try {
            claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        } catch {
            return null;
        }
        if (!claims.sid || !claims.sub || Date.now() > Number(claims.exp)) return null;
        const session = await this.store.get('sessions', claims.sid);
        if (!session || session.revokedAt || session.userId !== claims.sub) return null;
        if (Date.now() > Date.parse(session.expiresAt)) return null;
        return session;
    }

    async revokeSession(sessionId) {
        const session = await this.store.get('sessions', sessionId);
        if (session && !session.revokedAt) {
            session.revokedAt = new Date().toISOString();
            await this.store.put('sessions', session.id, session);
        }
        return session;
    }

    async revokeAllForUser(userId) {
        const sessions = await this.store.find('sessions', s => s.userId === userId && !s.revokedAt);
        for (const session of sessions) await this.revokeSession(session.id);
        return sessions.length;
    }
}

// --- Cookie + request helpers (framework-agnostic) -------------------------

function sessionCookie(token, { maxAgeMs = DEFAULT_TTL_MINUTES * 60 * 1000, secure = process.env.NODE_ENV === 'production' } = {}) {
    const parts = [
        `${COOKIE_NAME}=${encodeURIComponent(token)}`,
        'HttpOnly',
        'Path=/',
        'SameSite=Lax',
        `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
    ];
    if (secure) parts.push('Secure');
    return parts.join('; ');
}

function clearSessionCookie() {
    return `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
}

function tokenFromRequest(req) {
    const header = req.headers?.authorization;
    if (header && header.startsWith('Bearer ')) return header.slice('Bearer '.length);
    const cookieHeader = req.headers?.cookie;
    if (cookieHeader) {
        for (const part of cookieHeader.split(';')) {
            const [name, ...rest] = part.trim().split('=');
            if (name === COOKIE_NAME) return decodeURIComponent(rest.join('='));
        }
    }
    return null;
}

// Builds the (req) => user|null resolver expected by roles.authenticate().
function createSessionResolver(sessionService, userService) {
    return async (req) => {
        const session = await sessionService.verifySessionToken(tokenFromRequest(req));
        if (!session) return null;
        const user = await userService.getById(session.userId);
        return user || null;
    };
}

// Express-style middleware: attaches req.user / req.session or 401s.
function requireSession(sessionService, userService) {
    const resolve = createSessionResolver(sessionService, userService);
    return async (req, res, next) => {
        try {
            const user = await resolve(req);
            if (!user) return res.status(401).json({ error: 'You must be signed in.' });
            req.user = user;
            next();
        } catch (error) {
            next(error);
        }
    };
}

module.exports = {
    SessionService,
    sessionCookie,
    clearSessionCookie,
    tokenFromRequest,
    createSessionResolver,
    requireSession,
    COOKIE_NAME,
    DEFAULT_TTL_MINUTES,
};
