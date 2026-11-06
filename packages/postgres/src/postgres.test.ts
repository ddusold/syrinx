import { describeIdempotencyStore } from "@syrinx/testing/stores";
import pg from "pg";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresIdempotencyStore, type PostgresClient } from "./index.js";

// Runs against a real Postgres when DATABASE_URL is set (CI starts one); skipped otherwise.
const url = process.env.DATABASE_URL;
const skip = url ? false : "DATABASE_URL is not set";

const pool = new pg.Pool({ connectionString: url, max: 25 });
const sql = url ? postgres(url, { max: 25, onnotice: () => undefined }) : undefined;
const postgresJs: PostgresClient = {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- only called when DATABASE_URL is set
  query: async (text, values) => ({ rows: await sql!.unsafe(text, values as never[]) }),
};

beforeAll(async () => {
  if (!url) return;
  await createPostgresIdempotencyStore(pool).migrate();
  await createPostgresIdempotencyStore(pool, { table: "syrinx_idempotency_js" }).migrate();
});
afterAll(async () => {
  await pool.end();
  await sql?.end();
});

describeIdempotencyStore("postgres (node-postgres)", (timings) => createPostgresIdempotencyStore(pool, timings), {
  skip,
});
describeIdempotencyStore(
  "postgres (postgres.js)",
  (timings) => createPostgresIdempotencyStore(postgresJs, { ...timings, table: "syrinx_idempotency_js" }),
  { skip },
);

describe("postgres store", () => {
  it("refuses table names that are not plain identifiers", () => {
    expect(() => createPostgresIdempotencyStore(pool, { table: "x; DROP TABLE y" })).toThrow(/plain table name/);
    expect(() => createPostgresIdempotencyStore(pool, { table: "a.b.c" })).toThrow(/plain table name/);
    expect(() => createPostgresIdempotencyStore(pool, { table: "app.idempotency" })).not.toThrow();
  });

  it("refuses TTLs that are not positive whole milliseconds", () => {
    expect(() => createPostgresIdempotencyStore(pool, { ttlMs: 0 })).toThrow(/positive whole number/);
    expect(() => createPostgresIdempotencyStore(pool, { inFlightTtlMs: 2.5 })).toThrow(/positive whole number/);
  });

  it.skipIf(!url)("migrates idempotently and prunes expired records", async () => {
    const store = createPostgresIdempotencyStore(pool, { table: "syrinx_idempotency_prune", inFlightTtlMs: 1 });
    await store.migrate();
    await store.migrate();
    await store.prune();
    await store.begin(`prune/${crypto.randomUUID()}`, "fp");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(store.prune()).resolves.toBe(1);
  });
});
