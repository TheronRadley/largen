/**
 * Sliding-window rate limiter kept in memory. Good enough for a single-process app.
 */
export class RateLimiter {
  constructor({ limit, windowMs = 60_000, maxKeys = 10_000, now = () => Date.now() }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
    this.now = now;
    this.hits = new Map();
  }

  /** @returns {{allowed: boolean, retryAfterSec: number}} */
  hit(key) {
    if (!this.limit || this.limit <= 0) return { allowed: true, retryAfterSec: 0 };
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((ts) => t - ts < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return { allowed: false, retryAfterSec: Math.ceil((recent[0] + this.windowMs - t) / 1000) };
    }
    recent.push(t);
    this.hits.delete(key);
    this.hits.set(key, recent);
    if (this.hits.size > this.maxKeys) {
      this.hits.delete(this.hits.keys().next().value);
    }
    return { allowed: true, retryAfterSec: 0 };
  }
}
