import type { ErrorKind, FieldIssue } from "./errors.js";

/** The stored result of a write, replayed when the same key arrives again. */
export type IdempotencyOutcome =
  { ok: true; data: unknown } | { ok: false; kind: ErrorKind; message: string; issues: readonly FieldIssue[] };

export type IdempotencyClaim =
  | { status: "new" }
  | { status: "in_flight" }
  | { status: "mismatch" }
  | { status: "done"; outcome: IdempotencyOutcome };

/**
 * Deduplicates writes by key. `begin` claims a key for a request fingerprint; the pipeline then either `complete`s it
 * with the outcome or `release`s it so a retry can run. `@syrinx/redis` and `@syrinx/postgres` implement it for more
 * than one instance; `@syrinx/testing/stores` holds the contract every store passes.
 */
export interface IdempotencyStore {
  begin(key: string, fingerprint: string): Promise<IdempotencyClaim>;
  complete(key: string, outcome: IdempotencyOutcome): Promise<void>;
  release(key: string): Promise<void>;
}

export interface IdempotencyStoreOptions {
  /** How long a finished outcome is replayed. Defaults to 24 hours. */
  ttlMs?: number;
  /**
   * How long an unfinished claim holds its key. A process that dies mid-call never completes or releases it, so after
   * this the key can run again. Defaults to 5 minutes; set it above your slowest write.
   */
  inFlightTtlMs?: number;
}

export const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_IN_FLIGHT_TTL_MS = 5 * 60 * 1000;

type Entry = { fingerprint: string; expires: number } & ({ done: false } | { done: true; outcome: IdempotencyOutcome });

/** The reference store: one process only, so instances behind a load balancer do not see each other's keys. */
export function createMemoryIdempotencyStore({
  ttlMs = DEFAULT_IDEMPOTENCY_TTL_MS,
  inFlightTtlMs = DEFAULT_IN_FLIGHT_TTL_MS,
}: IdempotencyStoreOptions = {}): IdempotencyStore {
  const entries = new Map<string, Entry>();

  const live = (key: string) => {
    const entry = entries.get(key);
    if (entry && entry.expires <= Date.now()) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  };

  return {
    begin(key, fingerprint) {
      const entry = live(key);
      if (!entry) {
        entries.set(key, { fingerprint, expires: Date.now() + inFlightTtlMs, done: false });
        return Promise.resolve({ status: "new" });
      }
      if (entry.fingerprint !== fingerprint) return Promise.resolve({ status: "mismatch" });
      return Promise.resolve(entry.done ? { status: "done", outcome: entry.outcome } : { status: "in_flight" });
    },
    complete(key, outcome) {
      const entry = live(key);
      if (entry && !entry.done)
        entries.set(key, { fingerprint: entry.fingerprint, expires: Date.now() + ttlMs, done: true, outcome });
      return Promise.resolve();
    },
    release(key) {
      if (live(key)?.done === false) entries.delete(key);
      return Promise.resolve();
    },
  };
}
