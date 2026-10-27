'use strict';

const { createHmac, randomBytes, timingSafeEqual } = require('node:crypto');

// RFC 6238 TOTP (and RFC 4226 HOTP) implemented on node:crypto only.
// Secrets are 160-bit random values, stored base32-encoded (RFC 4648, the
// encoding authenticator apps expect in otpauth:// URIs).

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PERIOD_SECONDS = 30;
const DIGITS = 6;
const DEFAULT_WINDOW = 1; // accept one step either side for clock skew

function base32Encode(buffer) {
    let bits = 0;
    let value = 0;
    let output = '';
    for (const byte of buffer) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) {
        output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
    }
    return output;
}

function base32Decode(text) {
    const clean = String(text).replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
    let bits = 0;
    let value = 0;
    const bytes = [];
    for (const char of clean) {
        const index = BASE32_ALPHABET.indexOf(char);
        if (index === -1) throw new Error('Invalid base32 character in TOTP secret.');
        value = (value << 5) | index;
        bits += 5;
        if (bits >= 8) {
            bytes.push((value >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    return Buffer.from(bytes);
}

function generateSecret() {
    return base32Encode(randomBytes(20));
}

function hotp(secret, counter, digits = DIGITS) {
    const key = base32Decode(secret);
    const message = Buffer.alloc(8);
    message.writeBigUInt64BE(BigInt(counter));
    const digest = createHmac('sha1', key).update(message).digest();
    const offset = digest[digest.length - 1] & 0x0f;
    const binary = ((digest[offset] & 0x7f) << 24)
        | ((digest[offset + 1] & 0xff) << 16)
        | ((digest[offset + 2] & 0xff) << 8)
        | (digest[offset + 3] & 0xff);
    return String(binary % (10 ** digits)).padStart(digits, '0');
}

function totp(secret, { at = Date.now(), period = PERIOD_SECONDS, digits = DIGITS } = {}) {
    return hotp(secret, Math.floor(at / 1000 / period), digits);
}

// Accepts the current step plus `window` steps either side. Returns the
// matched counter (so callers can reject replay of the same code) or -1.
function verifyTotp(secret, code, { at = Date.now(), window = DEFAULT_WINDOW, period = PERIOD_SECONDS, digits = DIGITS } = {}) {
    const candidate = String(code ?? '').replace(/\s+/g, '');
    if (!new RegExp(`^\\d{${digits}}$`).test(candidate)) return -1;
    const current = Math.floor(at / 1000 / period);
    for (let step = -window; step <= window; step += 1) {
        const expected = hotp(secret, current + step, digits);
        const a = Buffer.from(expected);
        const b = Buffer.from(candidate);
        if (a.length === b.length && timingSafeEqual(a, b)) {
            return current + step;
        }
    }
    return -1;
}

function otpauthUri({ issuer, account, secret }) {
    const label = encodeURIComponent(`${issuer}:${account}`);
    const params = new URLSearchParams({
        secret,
        issuer,
        algorithm: 'SHA1',
        digits: String(DIGITS),
        period: String(PERIOD_SECONDS),
    });
    return `otpauth://totp/${label}?${params.toString()}`;
}

module.exports = {
    generateSecret,
    totp,
    verifyTotp,
    otpauthUri,
    base32Encode,
    base32Decode,
    PERIOD_SECONDS,
    DIGITS,
};
