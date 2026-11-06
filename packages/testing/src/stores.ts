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

/** Claims a key that must be new, and returns the claim's token. */
async function claim(store: IdempotencyStore, key: string, fingerprint: string) {
  const result = await store.begin(key, fingerprint);
  if (result.status !== "new") throw new Error(`expected a new claim of ${key}, got ${result.status}`);
  expect(result.token).toEqual(expect.any(String));
  return result.token;
}

/**
 * The contract every `IdempotencyStore` passes, as vitest tests: claims and their tokens, replays, mismatches, release,
 * both TTLs, stale claims and concurrent claims. `create` gets the timings to build the store with; keys are unique per
 * test, so a store shared between tests or runs (a real Redis or Postgres) is fine.
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
      await claim(s, k, "fp-1");
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
      await s.complete(k1, await claim(s, k1, "fp"), ok);
      await s.complete(k2, await claim(s, k2, "fp"), failed);
      await expect(s.begin(k1, "fp")).resolves.toEqual({ status: "done", outcome: ok });
      await expect(s.begin(k2, "fp")).resolves.toEqual({ status: "done", outcome: failed });
      await expect(s.begin(k1, "other")).resolves.toEqual({ status: "mismatch" });
    });

    it("replays results as JSON, whatever their type", async () => {
      const s = await store();
      for (const data of [null, 0, "text", [1, 2], true]) {
        const k = key("scalar");
        await s.complete(k, await claim(s, k, "fp"), { ok: true, data });
        await expect(s.begin(k, "fp")).resolves.toEqual({ status: "done", outcome: { ok: true, data } });
      }
      const k = key("date");
      await s.complete(k, await claim(s, k, "fp"), { ok: true, data: { at: new Date(0) } });
      await expect(s.begin(k, "fp")).resolves.toEqual({
        status: "done",
        outcome: { ok: true, data: { at: "1970-01-01T00:00:00.000Z" } },
      });
    });

    it("frees a released key for a retry, but never a completed one", async () => {
      const s = await store();
      const k = key("release");
      await s.release(k, await claim(s, k, "fp"));
      const token = await claim(s, k, "fp-2");
      await s.complete(k, token, { ok: true, data: 1 });
      await s.release(k, token);
      await expect(s.begin(k, "fp-2")).resolves.toEqual({ status: "done", outcome: { ok: true, data: 1 } });
    });

    it("ignores complete and release without the claim's token", async () => {
      const s = await store();
      const unclaimed = key("unclaimed");
      await s.complete(unclaimed, "no-such-token", { ok: true, data: 1 });
      await s.release(unclaimed, "no-such-token");
      await claim(s, unclaimed, "fp");

      const k = key("foreign");
      await claim(s, k, "fp");
      await s.complete(k, "someone-else", { ok: true, data: 1 });
      await s.release(k, "someone-else");
      await expect(s.begin(k, "fp")).resolves.toEqual({ status: "in_flight" });
    });

    it("expires an unfinished claim after inFlightTtlMs, and a finished one after ttlMs", async () => {
      const s = await store({ inFlightTtlMs: 150, ttlMs: 60_000 });
      const [stuck, done] = [key("stuck"), key("done")];
      await claim(s, stuck, "fp");
      await s.complete(done, await claim(s, done, "fp"), { ok: true, data: 1 });
      await sleep(400);
      await claim(s, stuck, "fp");
      await expect(s.begin(done, "fp")).resolves.toEqual({ status: "done", outcome: { ok: true, data: 1 } });

      const short = await store({ ttlMs: 150 });
      const k = key("short");
      await short.complete(k, await claim(short, k, "fp"), { ok: true, data: 1 });
      await sleep(400);
      await claim(short, k, "fp-2");
    });

    it("never lets a claim that outlived inFlightTtlMs finish or free the claim that took its key", async () => {
      const s = await store({ inFlightTtlMs: 150 });
      const k = key("stale");
      const stale = await claim(s, k, "fp-a");
      await sleep(400);
      const fresh = await claim(s, k, "fp-b");
      await s.complete(k, stale, { ok: true, data: "from the stale request" });
      await s.release(k, stale);
      await expect(s.begin(k, "fp-b")).resolves.toEqual({ status: "in_flight" });
      await s.complete(k, fresh, { ok: true, data: "from the fresh request" });
      await expect(s.begin(k, "fp-b")).resolves.toEqual({
        status: "done",
        outcome: { ok: true, data: "from the fresh request" },
      });
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
      const tokens = [];
      for (const [i, k] of keys.entries()) tokens.push(await claim(s, k, `fp-${i}`));
      for (const [i, k] of keys.entries()) {
        await s.complete(k, tokens[i] ?? "", { ok: true, data: i });
        await expect(s.begin(k, `fp-${i}`)).resolves.toEqual({ status: "done", outcome: { ok: true, data: i } });
      }
    });
  });
}
