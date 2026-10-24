import type {
  ClientRateLimitInfo,
  IncrementResponse,
  Options,
  Store,
} from "express-rate-limit";

/**
 * In-memory rate limit store for tests: counts like the Postgres store
 * (one window, never resets on its own) and records which limiter prefixes
 * and keys were used. `failing` makes every call throw.
 */
export function createRecordingStoreFactory(
  options: { failing?: boolean } = {},
) {
  const hits = new Map<string, number>();
  const prefixes: string[] = [];

  function createStore(prefix: string): Store {
    prefixes.push(prefix);
    const guard = () => {
      if (options.failing) {
        throw new Error("rate limit store unavailable");
      }
    };
    return {
      prefix,
      localKeys: false,
      init(_options: Options) {},
      async get(key): Promise<ClientRateLimitInfo | undefined> {
        guard();
        const count = hits.get(prefix + key);
        return count === undefined
          ? undefined
          : { totalHits: count, resetTime: undefined };
      },
      async increment(key): Promise<IncrementResponse> {
        guard();
        const count = (hits.get(prefix + key) ?? 0) + 1;
        hits.set(prefix + key, count);
        return { totalHits: count, resetTime: new Date(Date.now() + 60_000) };
      },
      async decrement(key) {
        guard();
        hits.set(prefix + key, Math.max(0, (hits.get(prefix + key) ?? 0) - 1));
      },
      async resetKey(key) {
        guard();
        hits.delete(prefix + key);
      },
    };
  }

  return {
    createStore,
    prefixes,
    /** Keys counted so far for one limiter prefix. */
    keysFor: (prefix: string) =>
      [...hits.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length)),
  };
}
