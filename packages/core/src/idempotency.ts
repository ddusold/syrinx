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
 * with the outcome or `release`s it so a retry can run. Postgres and Redis adapters (Phase 4) will implement the same interface.
 */
export interface IdempotencyStore {
  begin(key: string, fingerprint: string): Promise<IdempotencyClaim>;
  complete(key: string, outcome: IdempotencyOutcome): Promise<void>;
  release(key: string): Promise<void>;
}

type Entry = { fingerprint: string; expires: number } & ({ done: false } | { done: true; outcome: IdempotencyOutcome });

/** The reference store: one process, entries kept for `ttlMs` (default 24 hours). */
export function createMemoryIdempotencyStore({ ttlMs = 24 * 60 * 60 * 1000 } = {}): IdempotencyStore {
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
        entries.set(key, { fingerprint, expires: Date.now() + ttlMs, done: false });
        return Promise.resolve({ status: "new" });
      }
      if (entry.fingerprint !== fingerprint) return Promise.resolve({ status: "mismatch" });
      return Promise.resolve(entry.done ? { status: "done", outcome: entry.outcome } : { status: "in_flight" });
    },
    complete(key, outcome) {
      const entry = live(key);
      if (entry) entries.set(key, { fingerprint: entry.fingerprint, expires: entry.expires, done: true, outcome });
      return Promise.resolve();
    },
    release(key) {
      entries.delete(key);
      return Promise.resolve();
    },
  };
}
