import {
  idempotencyTimings,
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

// A claim is stored as "p:<token>:<fingerprint>" while in flight and "d:<fingerprint>\n<outcome JSON>" once done.
// complete and release act only on the caller's own claim. Each script reads and writes one key, so it is atomic and
// runs on Redis Cluster.
const BEGIN = `
local v = redis.call('GET', KEYS[1])
if not v then
  redis.call('SET', KEYS[1], 'p:' .. ARGV[1] .. ':' .. ARGV[2], 'PX', ARGV[3])
  return false
end
return v`;

const COMPLETE = `
local v = redis.call('GET', KEYS[1])
local mine = 'p:' .. ARGV[1] .. ':'
if v and string.sub(v, 1, #mine) == mine then
  redis.call('SET', KEYS[1], 'd:' .. string.sub(v, #mine + 1) .. '\\n' .. ARGV[2], 'PX', ARGV[3])
end
return 1`;

const RELEASE = `
local v = redis.call('GET', KEYS[1])
local mine = 'p:' .. ARGV[1] .. ':'
if v and string.sub(v, 1, #mine) == mine then redis.call('DEL', KEYS[1]) end
return 1`;

// Replies are strings, or buffers on clients set to return them; anything else (null) means no value.
const text = (value: unknown) =>
  typeof value === "string" ? value : value instanceof Uint8Array ? new TextDecoder().decode(value) : undefined;

const sha1 = async (script: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(script)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const noScript = (error: unknown) => error instanceof Error && error.message.startsWith("NOSCRIPT");

/** Idempotency records in Redis, shared by every instance pointed at it. Keys expire on their own. */
export function createRedisIdempotencyStore(
  client: RedisClient,
  { prefix = "syrinx:idempotency:", ...timings }: RedisIdempotencyStoreOptions = {},
): IdempotencyStore {
  const { ttlMs, inFlightTtlMs } = idempotencyTimings(timings);
  const command = send(client);
  const hashes = new Map<string, Promise<string>>();
  // EVALSHA sends only the script's hash; Redis answers NOSCRIPT when its cache lacks it (a restart, a new node), and
  // EVAL then sends the script once, caching it again.
  const evaluate = async (script: string, key: string, ...args: string[]) => {
    let hash = hashes.get(script);
    if (!hash) hashes.set(script, (hash = sha1(script)));
    try {
      return await command(["EVALSHA", await hash, "1", prefix + key, ...args]);
    } catch (error) {
      if (!noScript(error)) throw error;
      return command(["EVAL", script, "1", prefix + key, ...args]);
    }
  };

  return {
    async begin(key, fingerprint): Promise<IdempotencyClaim> {
      if (fingerprint.includes("\n")) throw new TypeError("An idempotency fingerprint cannot contain a newline.");
      const token = crypto.randomUUID();
      const stored = text(await evaluate(BEGIN, key, token, fingerprint, String(inFlightTtlMs)));
      if (stored === undefined) return { status: "new", token };
      const done = stored.startsWith("d:");
      // In flight: "p:<token>:<fingerprint>", and a token never holds ":".
      const found = done ? stored.slice(2, stored.indexOf("\n")) : stored.slice(stored.indexOf(":", 2) + 1);
      if (found !== fingerprint) return { status: "mismatch" };
      return done
        ? { status: "done", outcome: JSON.parse(stored.slice(stored.indexOf("\n") + 1)) as IdempotencyOutcome }
        : { status: "in_flight" };
    },
    async complete(key, token, outcome) {
      await evaluate(COMPLETE, key, token, JSON.stringify(outcome), String(ttlMs));
    },
    async release(key, token) {
      await evaluate(RELEASE, key, token);
    },
  };
}
