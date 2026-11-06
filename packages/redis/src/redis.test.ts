import { describeIdempotencyStore } from "@syrinx/testing/stores";
import { Redis } from "ioredis";
import { createClient } from "redis";
import { afterAll, beforeAll } from "vitest";
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
