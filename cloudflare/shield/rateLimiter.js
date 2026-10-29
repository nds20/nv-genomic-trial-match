/*
 * 824 Shield — defense against AI-driven attacks.
 * Copyright (C) 2026 Nicholas Smith / 824
 *
 * This file is part of 824 Shield, free software licensed under the
 * GNU General Public License v3.0 (see the LICENSE file).
 */

// Token-bucket rate limiting. AI-driven floods, scrapers, and stuffing
// runs all share one trait: inhuman cadence. A bucket per key (IP,
// account, API key) caps that cadence without punishing normal bursts.

export class TokenBucket {
  constructor({ capacity = 60, refillPerSec = 1, now = () => Date.now() } = {}) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.tokens = capacity;
    this.last = now();
    this.now = now;
  }

  refill() {
    const t = this.now();
    const elapsedSec = Math.max(0, (t - this.last) / 1000);
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSec);
    this.last = t;
  }

  take(cost = 1) {
    this.refill();
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return { allowed: true, remaining: Math.floor(this.tokens), retryAfterMs: 0 };
    }
    const missing = cost - this.tokens;
    const retryAfterMs = this.refillPerSec > 0 ? Math.ceil((missing / this.refillPerSec) * 1000) : Infinity;
    return { allowed: false, remaining: Math.floor(this.tokens), retryAfterMs };
  }
}

export class RateLimiter {
  constructor(options = {}) {
    this.options = options;
    this.buckets = new Map();
  }

  check(key, cost = 1) {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = new TokenBucket(this.options);
      this.buckets.set(key, bucket);
    }
    // Opportunistic cleanup so a long-lived process does not grow forever.
    if (this.buckets.size > 10000) {
      for (const [k, b] of this.buckets) {
        b.refill();
        if (b.tokens >= b.capacity) this.buckets.delete(k);
      }
    }
    return bucket.take(cost);
  }

  reset(key) {
    this.buckets.delete(key);
  }
}
