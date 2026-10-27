'use strict';

// Small shared error type so callers (and HTTP adapters) can map failures to
// stable machine-readable codes instead of matching on message text.
class AuthError extends Error {
    constructor(code, message, status = 400) {
        super(message);
        this.name = 'AuthError';
        this.code = code;
        this.status = status;
    }
}

function fail(code, message, status) {
    throw new AuthError(code, message, status);
}

module.exports = { AuthError, fail };
