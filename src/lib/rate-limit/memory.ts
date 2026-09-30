/** Sliding-window limiter kept in process memory. Local dev and tests only: it is per instance. */
export function createMemoryLimiter(max: number, windowMs: number, now: () => number = Date.now) {
  const hits = new Map<string, number[]>();
  return {
    /** Records an attempt for `key`. Returns false when the caller is over the limit. */
    take(key: string): boolean {
      const t = now();
      const recent = (hits.get(key) ?? []).filter((at) => t - at < windowMs);
      if (recent.length >= max) {
        hits.set(key, recent);
        return false;
      }
      recent.push(t);
      hits.set(key, recent);
      // Bound memory: drop keys whose newest hit has aged out.
      if (hits.size > 10_000) {
        for (const [k, v] of hits) if (t - (v.at(-1) ?? 0) >= windowMs) hits.delete(k);
      }
      return true;
    },
  };
}
