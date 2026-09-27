import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { applyMigrations } from "@vellar/service-kit";
import { createTestDatabase, dropTestDatabase } from "./test-database";

// Shared-database migrations against a real Postgres (issue #418). The
// all-in-one deploy migrates wallet-, policy- and verification-service into ONE
// database and ONE drizzle.__drizzle_migrations table. Each test gets a
// throwaway database so it starts from exactly what a new staging tier (or a
// recreated free-tier production DB) starts from.
const DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!DATABASE_URL && process.env.CI_REQUIRE_DB === "1") {
  throw new Error(
    "CI_REQUIRE_DB=1 but TEST_DATABASE_URL is unset — DB integration tests would silently skip.",
  );
}

const folder = (service: string) =>
  fileURLToPath(new URL(`../../../${service}-service/drizzle`, import.meta.url));
// all-in-one import order (services/all-in-one/src/index.ts).
const SERVICES = ["wallet", "policy", "verification"] as const;

describe.skipIf(!DATABASE_URL)("shared-database migrations", () => {
  const created: string[] = [];

  async function freshDatabase(): Promise<pg.Pool> {
    const url = await createTestDatabase(DATABASE_URL as string, "mig");
    created.push(url);
    return new pg.Pool({ connectionString: url, max: 1 });
  }

  async function tables(pool: pg.Pool): Promise<string[]> {
    const { rows } = await pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    );
    return rows.map((r) => r.tablename);
  }

  async function recorded(pool: pg.Pool): Promise<number> {
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "drizzle"."__drizzle_migrations"`,
    );
    return rows[0]?.n ?? 0;
  }

  async function runAll(pool: pg.Pool): Promise<void> {
    const client = await pool.connect();
    try {
      for (const service of SERVICES) await applyMigrations(client, folder(service));
    } finally {
      client.release();
    }
  }

  afterEach(async () => {
    for (const url of created.splice(0)) await dropTestDatabase(DATABASE_URL as string, url);
  });

  it("drizzle's timestamp rule skips whole services on a fresh shared DB (the defect)", async () => {
    const pool = await freshDatabase();
    try {
      for (const service of SERVICES) {
        await migrate(drizzle(pool), { migrationsFolder: folder(service) });
      }
      const t = await tables(pool);
      expect(t).toContain("wallets");
      expect(t).not.toContain("policies");
      expect(t).not.toContain("verification_records");
    } finally {
      await pool.end();
    }
  });

  it("creates every service's tables on a fresh shared DB", async () => {
    const pool = await freshDatabase();
    try {
      await runAll(pool);
      expect(await tables(pool)).toEqual(
        expect.arrayContaining([
          "wallets",
          "wallet_sessions",
          "activity_logs",
          "spend_ledger",
          "submission_replay",
          "policies",
          "verification_records",
        ]),
      );
    } finally {
      await pool.end();
    }
  });

  it("is idempotent: a second boot applies nothing", async () => {
    const pool = await freshDatabase();
    try {
      await runAll(pool);
      const before = await recorded(pool);
      const client = await pool.connect();
      try {
        for (const service of SERVICES) {
          expect(await applyMigrations(client, folder(service))).toBe(0);
        }
      } finally {
        client.release();
      }
      expect(await recorded(pool)).toBe(before);
    } finally {
      await pool.end();
    }
  });

  it("repairs a database migrated by the old rule without re-running recorded migrations", async () => {
    const pool = await freshDatabase();
    try {
      // Reproduce the legacy state: drizzle's own migrator, all-in-one order.
      for (const service of SERVICES) {
        await migrate(drizzle(pool), { migrationsFolder: folder(service) });
      }
      await pool.query(`INSERT INTO wallets VALUES ('k', 'C1', 'testnet', now())`);

      // Would throw "relation already exists" if any recorded migration re-ran.
      await runAll(pool);

      const t = await tables(pool);
      expect(t).toContain("policies");
      expect(t).toContain("verification_records");
      const { rows } = await pool.query("SELECT key_id FROM wallets");
      expect(rows).toEqual([{ key_id: "k" }]);
    } finally {
      await pool.end();
    }
  });

  it("treats a migration recorded from a CRLF checkout as applied", async () => {
    const pool = await freshDatabase();
    try {
      await runAll(pool);
      // Rewrite every recorded hash to the CRLF form of its file, as a Windows
      // checkout (core.autocrlf) would have recorded it.
      const client = await pool.connect();
      try {
        const { readMigrationFiles } = await import("drizzle-orm/migrator");
        const { createHash } = await import("node:crypto");
        for (const service of SERVICES) {
          for (const m of readMigrationFiles({ migrationsFolder: folder(service) })) {
            const crlf = m.sql
              .join("--> statement-breakpoint")
              .replace(/\r\n/g, "\n")
              .replace(/\n/g, "\r\n");
            await client.query(`UPDATE "drizzle"."__drizzle_migrations" SET hash = $1 WHERE hash = $2`, [
              createHash("sha256").update(crlf).digest("hex"),
              m.hash,
            ]);
          }
        }
        for (const service of SERVICES) {
          expect(await applyMigrations(client, folder(service))).toBe(0);
        }
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  });

  it("rolls back every pending migration when one fails", async () => {
    const pool = await freshDatabase();
    try {
      // Pre-create a table the policy init migration will collide with.
      await pool.query(`CREATE TABLE policies (x int)`);
      const client = await pool.connect();
      try {
        await expect(applyMigrations(client, folder("policy"))).rejects.toThrow(/already exists/);
      } finally {
        client.release();
      }
      expect(await recorded(pool)).toBe(0);
      expect(await tables(pool)).toEqual(["policies"]);
    } finally {
      await pool.end();
    }
  });
});
