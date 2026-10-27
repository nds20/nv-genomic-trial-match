'use strict';

const { randomBytes, createHash } = require('node:crypto');
const { newId } = require('./store');
const { fail } = require('./errors');

// Invite-only registration. There is deliberately NO public sign-up path:
// an account can only be created by consuming an invite an admin issued.
//
// Invites are bearer tokens (32 random bytes, base64url). The raw token is
// shown to the admin exactly once, at creation; the store only ever keeps
// its SHA-256 hash, so a leaked store file does not leak usable invites.
// Invites are single-use and expire (default 72 hours, INVITE_TTL_HOURS).

const DEFAULT_TTL_HOURS = 72;

function hashToken(token) {
    return createHash('sha256').update(String(token)).digest('hex');
}

function parsePositiveHours(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

class InviteService {
    constructor(store, { ttlHours } = {}) {
        this.store = store;
        this.ttlMs = parsePositiveHours(
            ttlHours ?? process.env.INVITE_TTL_HOURS,
            DEFAULT_TTL_HOURS,
        ) * 60 * 60 * 1000;
    }

    // Returns { invite, token } — `token` is the raw secret to hand to the
    // invitee (e.g. inside a registration link). It is never stored.
    async createInvite({ createdBy, email = null, role = 'doctor' } = {}) {
        if (!createdBy) fail('INVITE_CREATOR_REQUIRED', 'Invites must record which admin created them.');
        const token = randomBytes(32).toString('base64url');
        const now = new Date();
        const invite = {
            id: newId('inv'),
            tokenHash: hashToken(token),
            email: email ? String(email).toLowerCase() : null,
            role,
            createdBy,
            createdAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
            usedAt: null,
            usedByUserId: null,
        };
        await this.store.put('invites', invite.id, invite);
        return { invite, token };
    }

    // Validates a presented token without consuming it.
    async #findValidInvite(token) {
        if (!token || typeof token !== 'string') {
            fail('INVITE_REQUIRED', 'Registration requires an invitation.', 403);
        }
        const tokenHash = hashToken(token);
        const [invite] = await this.store.find('invites', i => i.tokenHash === tokenHash);
        if (!invite) fail('INVITE_INVALID', 'This invitation is not recognized.', 403);
        if (invite.usedAt) fail('INVITE_USED', 'This invitation has already been used.', 403);
        if (Date.now() > Date.parse(invite.expiresAt)) {
            fail('INVITE_EXPIRED', 'This invitation has expired. Ask an admin for a new one.', 403);
        }
        return invite;
    }

    async peekInvite(token) {
        const invite = await this.#findValidInvite(token);
        return { email: invite.email, role: invite.role, expiresAt: invite.expiresAt };
    }

    // Marks the invite used. Registration calls this last, after the user
    // record has been written, so a failed registration does not burn it.
    async consumeInvite(token, userId) {
        const invite = await this.#findValidInvite(token);
        invite.usedAt = new Date().toISOString();
        invite.usedByUserId = userId;
        await this.store.put('invites', invite.id, invite);
        return invite;
    }

    async listInvites() {
        const invites = await this.store.all('invites');
        return invites.map(({ tokenHash, ...rest }) => rest);
    }
}

module.exports = { InviteService, hashToken, DEFAULT_TTL_HOURS };
