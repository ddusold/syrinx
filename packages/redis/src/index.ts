import {
  DEFAULT_IDEMPOTENCY_TTL_MS,
  DEFAULT_IN_FLIGHT_TTL_MS,
  type IdempotencyClaim,
  type IdempotencyOutcome,
  type IdempotencyStore,
  type IdempotencyStoreOptions,
} from "@syrinx/core";

/**
 * The Redis client the stores run on: node-redis (`createClient()`, which has `sendCommand`) or ioredis (`new Redis()`,
 * which has `call`). Anything else with one of these methods works too, so Syrinx carries no Redis driver of its own.
 */
export type RedisClient =
  { call(command: string, ...args: string[]): Promise<unknown> } | { sendCommand(args: string[]): Promise<unknown> };

export interface RedisIdempotencyStoreOptions extends IdempotencyStoreOptions {
  /** Prepended to every key. Defaults to `syrinx:idempotency:`. */
  prefix?: string;
}

const send = (client: RedisClient) =>
  "call" in client
    ? (args: string[]) => client.call(args[0] ?? "", ...args.slice(1))
    : (args: string[]) => client.sendCommand(args);

// A claim is stored as "p:<fingerprint>" while in flight and "d:<fingerprint>\n<outcome JSON>" once done. Each script
// reads and writes one key, so it is atomic and runs on Redis Cluster.
const BEGIN = `
local v = redis.call('GET', KEYS[1])
if not v then
  redis.call('SET', KEYS[1], 'p:' .. ARGV[1], 'PX', ARGV[2])
  return false
end
return v`;

const COMPLETE = `
local v = redis.call('GET', KEYS[1])
if v and string.sub(v, 1, 2) == 'p:' then
  redis.call('SET', KEYS[1], 'd:' .. string.sub(v, 3) .. '\\n' .. ARGV[1], 'PX', ARGV[2])
end
return 1`;

const RELEASE = `
local v = redis.call('GET', KEYS[1])
if v and string.sub(v, 1, 2) == 'p:' then redis.call('DEL', KEYS[1]) end
return 1`;

// Replies are strings, or buffers on clients set to return them; anything else (null) means no value.
const text = (value: unknown) =>
  typeof value === "string" ? value : value instanceof Uint8Array ? new TextDecoder().decode(value) : undefined;

/** Idempotency records in Redis, shared by every instance pointed at it. Keys expire on their own. */
export function createRedisIdempotencyStore(
  client: RedisClient,
  {
    prefix = "syrinx:idempotency:",
    ttlMs = DEFAULT_IDEMPOTENCY_TTL_MS,
    inFlightTtlMs = DEFAULT_IN_FLIGHT_TTL_MS,
  }: RedisIdempotencyStoreOptions = {},
): IdempotencyStore {
  const command = send(client);
  const evaluate = (script: string, key: string, ...args: string[]) =>
    command(["EVAL", script, "1", prefix + key, ...args]);

  return {
    async begin(key, fingerprint): Promise<IdempotencyClaim> {
      if (fingerprint.includes("\n")) throw new TypeError("An idempotency fingerprint cannot contain a newline.");
      const stored = text(await evaluate(BEGIN, key, fingerprint, String(inFlightTtlMs)));
      if (stored === undefined) return { status: "new" };
      const done = stored.startsWith("d:");
      const end = done ? stored.indexOf("\n") : stored.length;
      if (stored.slice(2, end) !== fingerprint) return { status: "mismatch" };
      return done
        ? { status: "done", outcome: JSON.parse(stored.slice(end + 1)) as IdempotencyOutcome }
        : { status: "in_flight" };
    },
    async complete(key, outcome) {
      await evaluate(COMPLETE, key, JSON.stringify(outcome), String(ttlMs));
    },
    async release(key) {
      await evaluate(RELEASE, key);
    },
  };
}
