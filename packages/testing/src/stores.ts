import type { IdempotencyOutcome, IdempotencyStore } from "@syrinx/core";
import { describe, expect, it } from "vitest";

export interface StoreSuiteOptions {
  /** Skips the suite, for a store whose backing service is not configured (say, no `REDIS_URL`). A string says why. */
  skip?: boolean | string;
}

/** Times the suite gives the store, short so expiry can be tested in real time. */
export interface IdempotencyStoreTimings {
  ttlMs: number;
  inFlightTtlMs: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The contract every `IdempotencyStore` passes, as vitest tests: claims, replays, mismatches, release, both TTLs and
 * concurrent claims. `create` gets the timings to build the store with; keys are unique per test, so a store shared
 * between tests or runs (a real Redis or Postgres) is fine.
 */
export function describeIdempotencyStore(
  name: string,
  create: (timings: IdempotencyStoreTimings) => IdempotencyStore | Promise<IdempotencyStore>,
  options: StoreSuiteOptions = {},
) {
  const suite = options.skip ? describe.skip : describe;
  const title = typeof options.skip === "string" ? `${name} (skipped: ${options.skip})` : name;
  const store = (timings: Partial<IdempotencyStoreTimings> = {}) =>
    Promise.resolve(create({ ttlMs: 60_000, inFlightTtlMs: 60_000, ...timings }));
  const key = (label: string) => `contract/${crypto.randomUUID()}/${label}`;

  suite(`IdempotencyStore contract: ${title}`, () => {
    it("claims a new key once, and reports a repeat as in flight or a mismatch", async () => {
      const s = await store();
      const k = key("claim");
      await expect(s.begin(k, "fp-1")).resolves.toEqual({ status: "new" });
      await expect(s.begin(k, "fp-1")).resolves.toEqual({ status: "in_flight" });
      await expect(s.begin(k, "fp-2")).resolves.toEqual({ status: "mismatch" });
    });

    it("replays a completed outcome, successes and failures alike", async () => {
      const s = await store();
      const ok: IdempotencyOutcome = { ok: true, data: { id: "inv_1", lines: [{ cents: 1200 }], note: null } };
      const failed: IdempotencyOutcome = {
        ok: false,
        kind: "validation",
        message: "Bad input.",
        issues: [{ path: "lines.0.cents", message: "Must be positive." }],
      };
      const [k1, k2] = [key("ok"), key("failed")];
      await s.begin(k1, "fp");
      await s.complete(k1, ok);
      await s.begin(k2, "fp");
      await s.complete(k2, failed);
      await expect(s.begin(k1, "fp")).resolves.toEqual({ status: "done", outcome: ok });
      await expect(s.begin(k2, "fp")).resolves.toEqual({ status: "done", outcome: failed });
      await expect(s.begin(k1, "other")).resolves.toEqual({ status: "mismatch" });
    });

    it("keeps results that are not objects", async () => {
      const s = await store();
      for (const data of [null, 0, "text", [1, 2], true]) {
        const k = key("scalar");
        await s.begin(k, "fp");
        await s.complete(k, { ok: true, data });
        await expect(s.begin(k, "fp")).resolves.toEqual({ status: "done", outcome: { ok: true, data } });
      }
    });

    it("frees a released key for a retry, but never a completed one", async () => {
      const s = await store();
      const k = key("release");
      await s.begin(k, "fp");
      await s.release(k);
      await expect(s.begin(k, "fp-2")).resolves.toEqual({ status: "new" });
      await s.complete(k, { ok: true, data: 1 });
      await s.release(k);
      await expect(s.begin(k, "fp-2")).resolves.toEqual({ status: "done", outcome: { ok: true, data: 1 } });
    });

    it("ignores complete and release for keys it never claimed", async () => {
      const s = await store();
      const k = key("unclaimed");
      await s.complete(k, { ok: true, data: 1 });
      await s.release(k);
      await expect(s.begin(k, "fp")).resolves.toEqual({ status: "new" });
    });

    it("expires an unfinished claim after inFlightTtlMs, and a finished one after ttlMs", async () => {
      const s = await store({ inFlightTtlMs: 150, ttlMs: 60_000 });
      const [stuck, done] = [key("stuck"), key("done")];
      await s.begin(stuck, "fp");
      await s.begin(done, "fp");
      await s.complete(done, { ok: true, data: 1 });
      await sleep(400);
      await expect(s.begin(stuck, "fp")).resolves.toEqual({ status: "new" });
      await expect(s.begin(done, "fp")).resolves.toEqual({ status: "done", outcome: { ok: true, data: 1 } });

      const short = await store({ ttlMs: 150 });
      const k = key("short");
      await short.begin(k, "fp");
      await short.complete(k, { ok: true, data: 1 });
      await sleep(400);
      await expect(short.begin(k, "fp-2")).resolves.toEqual({ status: "new" });
    });

    it("gives a key to exactly one of many concurrent claims", async () => {
      const s = await store();
      const k = key("race");
      const claims = await Promise.all(Array.from({ length: 20 }, () => s.begin(k, "fp")));
      expect(claims.filter((c) => c.status === "new")).toHaveLength(1);
      expect(claims.filter((c) => c.status === "in_flight")).toHaveLength(19);
    });

    it("keeps keys apart, whatever characters they hold", async () => {
      const s = await store();
      const base = key("chars");
      const keys = [`${base}/a`, `${base}/a/`, `${base}/'quoted" ; --`, `${base}/ünïcødé/✓`, `${base}/\nline`];
      for (const [i, k] of keys.entries()) await expect(s.begin(k, `fp-${i}`)).resolves.toEqual({ status: "new" });
      for (const [i, k] of keys.entries()) {
        await s.complete(k, { ok: true, data: i });
        await expect(s.begin(k, `fp-${i}`)).resolves.toEqual({ status: "done", outcome: { ok: true, data: i } });
      }
    });
  });
}
