const textEncoder = new TextEncoder();

export function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(value) {
  const binary = atob(String(value));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function bytesToBase64Url(bytes) {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function base64UrlToBytes(value) {
  const normalized = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return base64ToBytes(padded);
}

export function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= a[i] ^ b[i];
  return difference === 0;
}

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(String(value)));
  return bytesToHex(new Uint8Array(digest));
}

const PBKDF2_ITERATIONS = 210000;

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12) {
    const error = new Error('Password must be at least 12 characters.');
    error.code = 'WEAK_PASSWORD';
    error.status = 400;
    throw error;
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', textEncoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  return ['pbkdf2-sha256', PBKDF2_ITERATIONS, bytesToBase64(salt), bytesToBase64(new Uint8Array(derived))].join('$');
}

export async function verifyPassword(password, stored) {
  try {
    const [scheme, iterationsText, saltB64, hashB64] = String(stored).split('$');
    if (scheme !== 'pbkdf2-sha256') return false;
    const iterations = Number(iterationsText);
    if (!Number.isInteger(iterations) || iterations < 100000 || iterations > 1000000) return false;
    const salt = base64ToBytes(saltB64);
    const expected = base64ToBytes(hashB64);
    const key = await crypto.subtle.importKey('raw', textEncoder.encode(String(password)), 'PBKDF2', false, ['deriveBits']);
    const derived = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
      key,
      expected.length * 8,
    );
    return timingSafeEqual(expected, new Uint8Array(derived));
  } catch {
    return false;
  }
}

export async function hmacSha256(secret, value, encoding = 'base64url') {
  const key = await crypto.subtle.importKey(
    'raw', textEncoder.encode(String(secret)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, textEncoder.encode(String(value))));
  return encoding === 'hex' ? bytesToHex(signature) : bytesToBase64Url(signature);
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(text) {
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
  return new Uint8Array(bytes);
}

export function generateTotpSecret() {
  return base32Encode(crypto.getRandomValues(new Uint8Array(20)));
}

async function hotp(secret, counter) {
  const keyBytes = base32Decode(secret);
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const message = new Uint8Array(8);
  new DataView(message.buffer).setBigUint64(0, BigInt(counter));
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, message));
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 1000000).padStart(6, '0');
}

export async function totp(secret, { at = Date.now(), period = 30 } = {}) {
  return hotp(secret, Math.floor(at / 1000 / period));
}

export async function verifyTotp(secret, code, { at = Date.now(), window = 1, period = 30 } = {}) {
  const candidate = String(code ?? '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(candidate)) return -1;
  const current = Math.floor(at / 1000 / period);
  for (let step = -window; step <= window; step += 1) {
    const expected = await hotp(secret, current + step);
    if (timingSafeEqual(textEncoder.encode(expected), textEncoder.encode(candidate))) return current + step;
  }
  return -1;
}

export function otpauthUri({ issuer, account, secret }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${label}?${params.toString()}`;
}
