/*
 * 824 Shield — defense against AI-driven attacks.
 * Copyright (C) 2026 Nicholas Smith / 824
 *
 * This file is part of 824 Shield, free software licensed under the
 * GNU General Public License v3.0 (see the LICENSE file).
 */

// The Shield: combines rate, bot, and content signals into one decision
// per request — allow, challenge, or block — plus a login guard that
// locks out credential-stuffing runs. Every decision can be streamed to
// your audit log through the onDecision callback.

import { scanText } from './injection.js';
import { RateLimiter } from './rateLimiter.js';
import { scoreBot } from './botScore.js';
import { scanPayload, scanPath } from './exploits.js';

const DEFAULTS = {
  injectionChallengeAt: 30,
  injectionBlockAt: 60,
  exploitChallengeAt: 30,
  exploitBlockAt: 60,
  botChallengeAt: 50,
  botBlockAt: 85,
  rate: { capacity: 60, refillPerSec: 1 },
  login: { maxFailures: 5, windowMs: 15 * 60 * 1000, lockoutMs: 15 * 60 * 1000 },
  allowlist: [],
  blocklist: [],
  allowlistIps: [],
  maxBodyBytes: 1000000,
  onDecision: null,
};

export class Shield {
  constructor(config = {}) {
    this.cfg = { ...DEFAULTS, ...config };
    this.limiter = new RateLimiter(this.cfg.rate);
    this.loginState = new Map(); // key -> { count, firstAt, lockedUntil }
  }

  // ctx: { ip, method, path, headers (lowercase keys), bodyText }
  evaluate(ctx = {}) {
    const reasons = [];
    let action = 'allow';
    const ip = ctx.ip || 'unknown';

    if (this.cfg.blocklist.includes(ip)) {
      const decision = {
        action: 'block', ip,
        method: ctx.method || 'GET', path: ctx.path || '/',
        scores: { bot: 0, injection: 0, exploit: 0 },
        reasons: ['Source IP is on the blocklist'],
        at: new Date().toISOString(),
      };
      if (typeof this.cfg.onDecision === 'function') this.cfg.onDecision(decision);
      return decision;
    }
    const trustedIp = this.cfg.allowlistIps.includes(ip);

    const rl = trustedIp ? { allowed: true, retryAfterMs: 0 } : this.limiter.check(`ip:${ip}`);
    if (!rl.allowed) {
      action = 'block';
      reasons.push(`Rate limit exceeded (retry after ~${Math.ceil(rl.retryAfterMs / 1000)}s)`);
    }

    const bot = trustedIp ? { score: 0, reasons: [] } : scoreBot(ctx.headers || {}, { allowlist: this.cfg.allowlist });
    for (const r of bot.reasons) reasons.push(r);
    if (bot.score >= this.cfg.botBlockAt) action = 'block';
    else if (bot.score >= this.cfg.botChallengeAt && action === 'allow') action = 'challenge';

    let injection = { score: 0, hits: [] };
    if (ctx.bodyText) {
      injection = scanText(ctx.bodyText);
      for (const hit of injection.hits) reasons.push(`Prompt-injection signal: ${hit.label}`);
      if (injection.score >= this.cfg.injectionBlockAt) action = 'block';
      else if (injection.score >= this.cfg.injectionChallengeAt && action === 'allow') action = 'challenge';
    }

    if (ctx.bodyText && ctx.bodyText.length > this.cfg.maxBodyBytes) {
      action = 'block';
      reasons.push(`Payload size ${ctx.bodyText.length} exceeds the ${this.cfg.maxBodyBytes}-byte limit`);
    }

    const probe = scanPath(ctx.path || '/');
    const payload = ctx.bodyText ? scanPayload(ctx.bodyText) : { score: 0, hits: [] };
    const exploit = {
      score: probe.score + payload.score,
      hits: [...probe.hits, ...payload.hits],
    };
    for (const hit of exploit.hits) reasons.push(`Cyber-exploit signal: ${hit.label}`);
    if (exploit.score >= this.cfg.exploitBlockAt) action = 'block';
    else if (exploit.score >= this.cfg.exploitChallengeAt && action === 'allow') action = 'challenge';

    const decision = {
      action,
      ip,
      method: ctx.method || 'GET',
      path: ctx.path || '/',
      scores: { bot: bot.score, injection: injection.score, exploit: exploit.score },
      reasons,
      at: new Date().toISOString(),
    };
    if (typeof this.cfg.onDecision === 'function') this.cfg.onDecision(decision);
    return decision;
  }

  // --- Credential-stuffing guard -------------------------------------
  // Track failures per source IP and per account; either one tripping
  // the limit locks the pair out for the lockout window.

  #bump(key) {
    const { maxFailures, windowMs, lockoutMs } = this.cfg.login;
    const now = Date.now();
    let state = this.loginState.get(key);
    if (!state || now - state.firstAt > windowMs) {
      state = { count: 0, firstAt: now, lockedUntil: 0 };
    }
    state.count += 1;
    if (state.count >= maxFailures) state.lockedUntil = now + lockoutMs;
    this.loginState.set(key, state);
    return state;
  }

  recordLoginFailure(ip, account) {
    this.#bump(`ip:${ip}`);
    if (account) this.#bump(`acct:${String(account).toLowerCase()}`);
  }

  recordLoginSuccess(ip, account) {
    this.loginState.delete(`ip:${ip}`);
    if (account) this.loginState.delete(`acct:${String(account).toLowerCase()}`);
  }

  loginLocked(ip, account) {
    const now = Date.now();
    const keys = [`ip:${ip}`, account ? `acct:${String(account).toLowerCase()}` : null];
    for (const key of keys) {
      if (!key) continue;
      const state = this.loginState.get(key);
      if (state && state.lockedUntil > now) {
        return { locked: true, retryAfterMs: state.lockedUntil - now };
      }
    }
    return { locked: false, retryAfterMs: 0 };
  }
}
