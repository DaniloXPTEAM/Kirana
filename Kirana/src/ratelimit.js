/** Rate limiting em memória (janela deslizante) por origem. */
export function createRateLimiter({ max = 20, windowMs = 60_000, now = () => Date.now() } = {}) {
  const hits = new Map(); // key -> number[]

  const prune = (timestamps, current) => {
    while (timestamps.length && current - timestamps[0] >= windowMs) timestamps.shift();
    return timestamps;
  };

  return {
    check(key) {
      const current = now();
      const timestamps = prune(hits.get(key) ?? [], current);
      if (timestamps.length >= max) {
        hits.set(key, timestamps);
        return { allowed: false, remaining: 0, retryAfterMs: windowMs - (current - timestamps[0]) };
      }
      timestamps.push(current);
      hits.set(key, timestamps);
      return { allowed: true, remaining: Math.max(0, max - timestamps.length), retryAfterMs: 0 };
    },
    reset() {
      hits.clear();
    },
  };
}
