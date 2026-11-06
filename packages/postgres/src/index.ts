import {
  idempotencyTimings,
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
  { table = "syrinx_idempotency", ...timings }: PostgresIdempotencyStoreOptions = {},
): PostgresIdempotencyStore {
  const { ttlMs, inFlightTtlMs } = idempotencyTimings(timings);
  const t = quote(table);
  const index = quote(`${table.split(".").pop() ?? table}_expires_at`);

  // One round trip: the insert claims a missing or expired key, and the outer select reads the live row otherwise. A
  // live key's row is left alone; concurrent claims of one key queue on its row lock, so exactly one gets it. A claim
  // committed after this statement's snapshot shows as neither, and the loop asks again.
  const claim = `WITH claimed AS (
      INSERT INTO ${t} AS e (key, fingerprint, token, outcome, expires_at) VALUES ($1, $2, $3, NULL, ${later("$4")})
      ON CONFLICT (key) DO UPDATE
        SET fingerprint = EXCLUDED.fingerprint, token = EXCLUDED.token, outcome = NULL, expires_at = EXCLUDED.expires_at
        WHERE e.expires_at <= now()
      RETURNING key
    )
    SELECT (SELECT count(*) FROM claimed)::int AS claimed, r.fingerprint, r.outcome
    FROM (SELECT 1) one LEFT JOIN ${t} r ON r.key = $1 AND r.expires_at > now()`;

  return {
    async begin(key, fingerprint): Promise<IdempotencyClaim> {
      for (let attempt = 0; attempt < 5; attempt++) {
        const token = crypto.randomUUID();
        const row = (await client.query(claim, [key, fingerprint, token, inFlightTtlMs])).rows[0];
        if (Number(row?.claimed) > 0) return { status: "new", token };
        if (row?.fingerprint === null || row?.fingerprint === undefined) continue;
        if (row.fingerprint !== fingerprint) return { status: "mismatch" };
        return typeof row.outcome === "string"
          ? { status: "done", outcome: JSON.parse(row.outcome) as IdempotencyOutcome }
          : { status: "in_flight" };
      }
      throw new Error(`Could not claim idempotency key "${key}".`);
    },
    async complete(key, token, outcome) {
      await client.query(
        `UPDATE ${t} SET outcome = $3, token = NULL, expires_at = ${later("$4")}
         WHERE key = $1 AND token = $2 AND outcome IS NULL AND expires_at > now()`,
        [key, token, JSON.stringify(outcome), ttlMs],
      );
    },
    async release(key, token) {
      await client.query(`DELETE FROM ${t} WHERE key = $1 AND token = $2 AND outcome IS NULL`, [key, token]);
    },
    async migrate() {
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${t} (key text PRIMARY KEY, fingerprint text NOT NULL, token text, outcome text, expires_at timestamptz NOT NULL)`,
      );
      await client.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS token text`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${index} ON ${t} (expires_at)`);
    },
    async prune() {
      const deleted = `WITH d AS (DELETE FROM ${t} WHERE expires_at <= now() RETURNING 1) SELECT count(*)::int AS n FROM d`;
      return Number((await client.query(deleted)).rows[0]?.n ?? 0);
    },
  };
}
