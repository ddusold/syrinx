import {
  DEFAULT_IDEMPOTENCY_TTL_MS,
  DEFAULT_IN_FLIGHT_TTL_MS,
  type IdempotencyClaim,
  type IdempotencyOutcome,
  type IdempotencyStore,
  type IdempotencyStoreOptions,
} from "@syrinx/core";

/**
 * The Postgres client the stores run on: a node-postgres `Pool` or `Client` as is. For postgres.js, pass
 * `{ query: async (text, values) => ({ rows: await sql.unsafe(text, values) }) }`. Syrinx carries no driver of its own.
 */
export interface PostgresClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface PostgresIdempotencyStoreOptions extends IdempotencyStoreOptions {
  /** The table records live in, optionally schema-qualified. Defaults to `syrinx_idempotency`. */
  table?: string;
}

export interface PostgresIdempotencyStore extends IdempotencyStore {
  /** Creates the table and its expiry index if they are missing. Run it once, at deploy or startup. */
  migrate(): Promise<void>;
  /** Deletes expired records and returns how many went. Expired records are never replayed, so this only saves space. */
  prune(): Promise<number>;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

const quote = (table: string) => {
  const parts = table.split(".");
  if (parts.length > 2 || !parts.every((part) => IDENTIFIER.test(part)))
    throw new TypeError(
      `"${table}" is not a plain table name (letters, digits, underscores; optionally schema.table).`,
    );
  return parts.map((part) => `"${part}"`).join(".");
};

const later = (param: string) => `now() + make_interval(secs => ${param}::double precision / 1000)`;

/** Idempotency records in one Postgres table, shared by every instance using the database. */
export function createPostgresIdempotencyStore(
  client: PostgresClient,
  {
    table = "syrinx_idempotency",
    ttlMs = DEFAULT_IDEMPOTENCY_TTL_MS,
    inFlightTtlMs = DEFAULT_IN_FLIGHT_TTL_MS,
  }: PostgresIdempotencyStoreOptions = {},
): PostgresIdempotencyStore {
  const t = quote(table);
  const index = quote(`${table.split(".").pop() ?? table}_expires_at`);

  // The insert claims a missing or expired key; a live key's row is left alone and returns nothing. Concurrent claims
  // of one key queue on its row lock, so exactly one of them gets the row back.
  const claim = `INSERT INTO ${t} AS e (key, fingerprint, outcome, expires_at) VALUES ($1, $2, NULL, ${later("$3")})
    ON CONFLICT (key) DO UPDATE SET fingerprint = EXCLUDED.fingerprint, outcome = NULL, expires_at = EXCLUDED.expires_at
    WHERE e.expires_at <= now()
    RETURNING key`;
  const current = `SELECT fingerprint, outcome FROM ${t} WHERE key = $1 AND expires_at > now()`;

  return {
    async begin(key, fingerprint): Promise<IdempotencyClaim> {
      // A live row seen by the insert can expire before the select reads it; then claim again.
      for (let attempt = 0; attempt < 3; attempt++) {
        if ((await client.query(claim, [key, fingerprint, inFlightTtlMs])).rows.length > 0) return { status: "new" };
        const row = (await client.query(current, [key])).rows[0];
        if (!row) continue;
        if (row.fingerprint !== fingerprint) return { status: "mismatch" };
        return typeof row.outcome === "string"
          ? { status: "done", outcome: JSON.parse(row.outcome) as IdempotencyOutcome }
          : { status: "in_flight" };
      }
      throw new Error(`Could not claim idempotency key "${key}".`);
    },
    async complete(key, outcome) {
      await client.query(
        `UPDATE ${t} SET outcome = $2, expires_at = ${later("$3")} WHERE key = $1 AND outcome IS NULL AND expires_at > now()`,
        [key, JSON.stringify(outcome), ttlMs],
      );
    },
    async release(key) {
      await client.query(`DELETE FROM ${t} WHERE key = $1 AND outcome IS NULL`, [key]);
    },
    async migrate() {
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${t} (key text PRIMARY KEY, fingerprint text NOT NULL, outcome text, expires_at timestamptz NOT NULL)`,
      );
      await client.query(`CREATE INDEX IF NOT EXISTS ${index} ON ${t} (expires_at)`);
    },
    async prune() {
      return (await client.query(`DELETE FROM ${t} WHERE expires_at <= now() RETURNING key`)).rows.length;
    },
  };
}
