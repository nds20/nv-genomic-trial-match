/*
 * 824 Shield — defense against AI-driven attacks.
 * Copyright (C) 2026 Nicholas Smith / 824
 *
 * This file is part of 824 Shield, free software licensed under the
 * GNU General Public License v3.0 (see the LICENSE file).
 */

// Defensive response headers: the cheap, always-on layer that blunts
// clickjacking, MIME sniffing, referrer leakage, and (via a strict
// Content-Security-Policy) limits the blast radius if an XSS payload
// ever does land. securityHeaders() returns a plain object the
// adapters apply; tune the CSP for apps that load third-party assets.

export function securityHeaders(options = {}) {
  const {
    contentSecurityPolicy =
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data:; font-src 'self'; connect-src 'self'; " +
      "frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    frameOption = 'DENY',
    hstsMaxAgeDays = 180,
  } = options;

  return {
    'Content-Security-Policy': contentSecurityPolicy,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': frameOption,
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Strict-Transport-Security': `max-age=${hstsMaxAgeDays * 24 * 60 * 60}; includeSubDomains`,
  };
}

// Apply the headers to a fetch-style Response (Cloudflare Workers,
// any runtime with the standard Response global). Existing headers
// set by the application win; Shield fills the gaps.
export function applySecurityHeaders(response, options = {}) {
  const wrapped = new Response(response.body, response);
  for (const [name, value] of Object.entries(securityHeaders(options))) {
    if (!wrapped.headers.has(name)) wrapped.headers.set(name, value);
  }
  return wrapped;
}
