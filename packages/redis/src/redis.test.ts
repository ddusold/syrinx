import { describeIdempotencyStore } from "@syrinx/testing/stores";
import { Redis } from "ioredis";
import { createClient } from "redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRedisIdempotencyStore } from "./index.js";

// Runs against a real Redis when REDIS_URL is set (CI starts one); skipped otherwise.
const url = process.env.REDIS_URL;
const skip = url ? false : "REDIS_URL is not set";

const nodeRedis = createClient(url ? { url } : {});
const ioredis = url ? new Redis(url, { lazyConnect: true }) : undefined;

beforeAll(async () => {
  if (!url) return;
  await nodeRedis.connect();
  await ioredis?.connect();
});
afterAll(() => {
  if (!url) return;
  nodeRedis.destroy();
  ioredis?.disconnect();
});

describeIdempotencyStore("redis (node-redis)", (timings) => createRedisIdempotencyStore(nodeRedis, timings), { skip });
describeIdempotencyStore(
  "redis (ioredis)",
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- skipped when there is no REDIS_URL
  (timings) => createRedisIdempotencyStore(ioredis!, { ...timings, prefix: "syrinx-test:io:" }),
  { skip },
);

describe("redis store", () => {
  it("refuses TTLs Redis cannot take", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createRedisIdempotencyStore(nodeRedis, { ttlMs: bad })).toThrow(/positive whole number/);
      expect(() => createRedisIdempotencyStore(nodeRedis, { inFlightTtlMs: bad })).toThrow(/positive whole number/);
    }
  });

  it.skipIf(!url)("sends scripts again after Redis forgets them", async () => {
    const store = createRedisIdempotencyStore(nodeRedis, { prefix: "syrinx-test:flush:" });
    const key = crypto.randomUUID();
    const first = await store.begin(key, "fp");
    await nodeRedis.sendCommand(["SCRIPT", "FLUSH"]);
    if (first.status !== "new") throw new Error("expected a new claim");
    await store.complete(key, first.token, { ok: true, data: 1 });
    await expect(store.begin(key, "fp")).resolves.toEqual({ status: "done", outcome: { ok: true, data: 1 } });
  });
});
