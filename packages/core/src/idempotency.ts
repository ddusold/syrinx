import type { ErrorKind, FieldIssue } from "./errors.js";

/** The stored result of a write, replayed when the same key arrives again. */
export type IdempotencyOutcome =
  { ok: true; data: unknown } | { ok: false; kind: ErrorKind; message: string; issues: readonly FieldIssue[] };

export type IdempotencyClaim =
  | { status: "new"; token: string }
  | { status: "in_flight" }
  | { status: "mismatch" }
  | { status: "done"; outcome: IdempotencyOutcome };

/**
 * Deduplicates writes by key. `begin` claims a key for a request fingerprint and returns a token for the claim; the
 * pipeline then either `complete`s it with the outcome or `release`s it so a retry can run. Both take the token and do
 * nothing unless it is the key's current, unfinished claim, so a request that outlived `inFlightTtlMs` cannot finish or
 * free the claim of the request that took the key over. `@syrinx/redis` and `@syrinx/postgres` implement it for more
 * than one instance; `@syrinx/testing/stores` holds the contract every store passes.
 */
export interface IdempotencyStore {
  begin(key: string, fingerprint: string): Promise<IdempotencyClaim>;
  complete(key: string, token: string, outcome: IdempotencyOutcome): Promise<void>;
  release(key: string, token: string): Promise<void>;
}

export interface IdempotencyStoreOptions {
  /** How long a finished outcome is replayed, in whole milliseconds. Defaults to 24 hours. */
  ttlMs?: number;
  /**
   * How long an unfinished claim holds its key, in whole milliseconds. A process that dies mid-call never completes or
   * releases it, so after this the key can run again. Defaults to 5 minutes; set it above your slowest write.
   */
  inFlightTtlMs?: number;
}

export const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_IN_FLIGHT_TTL_MS = 5 * 60 * 1000;

/** A store's TTLs with defaults filled in. Throws unless each is a positive whole number of milliseconds. */
export function idempotencyTimings({
  ttlMs = DEFAULT_IDEMPOTENCY_TTL_MS,
  inFlightTtlMs = DEFAULT_IN_FLIGHT_TTL_MS,
}: IdempotencyStoreOptions = {}): Required<IdempotencyStoreOptions> {
  for (const [name, value] of Object.entries({ ttlMs, inFlightTtlMs }))
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new RangeError(`${name} must be a positive whole number of milliseconds, got ${String(value)}.`);
  return { ttlMs, inFlightTtlMs };
}

export interface MemoryIdempotencyStoreOptions extends IdempotencyStoreOptions {
  /** The most keys kept at once; the oldest go first past it. Defaults to 100,000. */
  maxEntries?: number;
}

// Outcomes are kept as JSON, as the shared stores keep them, so a replay has the same shape whichever store is used.
type Entry = { fingerprint: string; expires: number } & (
  { done: false; token: string } | { done: true; outcome: string }
);

/** The reference store: one process only, so instances behind a load balancer do not see each other's keys. */
export function createMemoryIdempotencyStore(options: MemoryIdempotencyStoreOptions = {}): IdempotencyStore {
  const { ttlMs, inFlightTtlMs } = idempotencyTimings(options);
  const maxEntries = options.maxEntries ?? 100_000;
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0)
    throw new RangeError("maxEntries must be a positive integer.");
  const entries = new Map<string, Entry>();
  let nextSweep = Date.now() + inFlightTtlMs;

  // Expired keys nobody asks about again would stay forever; drop them every inFlightTtlMs, and the oldest past the cap.
  const sweep = (now: number) => {
    if (now >= nextSweep) {
      nextSweep = now + inFlightTtlMs;
      for (const [key, entry] of entries) if (entry.expires <= now) entries.delete(key);
    }
    for (const key of entries.keys()) {
      if (entries.size < maxEntries) break;
      entries.delete(key);
    }
  };

  const live = (key: string) => {
    const entry = entries.get(key);
    if (entry && entry.expires <= Date.now()) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  };
  const claimed = (key: string, token: string) => {
    const entry = live(key);
    return entry && !entry.done && entry.token === token ? entry : undefined;
  };

  return {
    begin(key, fingerprint) {
      const entry = live(key);
      if (!entry) {
        const now = Date.now();
        sweep(now);
        const token = crypto.randomUUID();
        entries.set(key, { fingerprint, expires: now + inFlightTtlMs, done: false, token });
        return Promise.resolve({ status: "new", token });
      }
      if (entry.fingerprint !== fingerprint) return Promise.resolve({ status: "mismatch" });
      return Promise.resolve(
        entry.done
          ? { status: "done", outcome: JSON.parse(entry.outcome) as IdempotencyOutcome }
          : { status: "in_flight" },
      );
    },
    complete(key, token, outcome) {
      const entry = claimed(key, token);
      if (entry) {
        const done: Entry = {
          fingerprint: entry.fingerprint,
          expires: Date.now() + ttlMs,
          done: true,
          outcome: JSON.stringify(outcome),
        };
        entries.delete(key); // re-inserted last, so the cap evicts it after older keys
        entries.set(key, done);
      }
      return Promise.resolve();
    },
    release(key, token) {
      if (claimed(key, token)) entries.delete(key);
      return Promise.resolve();
    },
  };
}
