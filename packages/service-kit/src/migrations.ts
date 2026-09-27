import { createHash } from "node:crypto";
import { readMigrationFiles, type MigrationMeta } from "drizzle-orm/migrator";

// Hash-based migration runner for a Postgres database SHARED by several
// services (issue #418 — found by booting the full stack against a fresh
// database, which is what a new staging tier, or a recreated free-tier
// production database, starts from).
//
// wallet-, policy- and verification-service each ship an independent drizzle
// journal but, in the all-in-one deploy, migrate into ONE database and ONE
// drizzle.__drizzle_migrations table. drizzle's migrator applies a migration
// only when its journal timestamp is newer than the NEWEST row in that table.
// With three interleaved journals that rule silently skips every service whose
// migrations are older than the last one another service recorded: on a fresh
// database, booting wallet-service first left policy-service's `policies` and
// verification-service's `verification_records` tables uncreated.
//
// This runner keeps drizzle's file format, hashing and bookkeeping table (rows
// stay readable by drizzle tooling) but applies each migration whose HASH is
// not recorded — the question that actually matters in a shared table. On an
// existing database every already-recorded migration is skipped, so nothing
// re-runs; a migration that the timestamp rule skipped is applied.
//
// Callers must hold the cross-service migration advisory lock (see each
// service's db/client.ts) so concurrent boots cannot interleave.

export interface MigrationClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const BREAKPOINT = "--> statement-breakpoint";

/** drizzle hashes the raw file bytes, so the same migration checked out with
 * CRLF (Windows) and LF (CI/Render) line endings records different hashes.
 * Treat either form as applied so a database migrated from one checkout is not
 * re-migrated from the other. */
function recordedForms(migration: MigrationMeta): string[] {
  const raw = migration.sql.join(BREAKPOINT);
  const lf = raw.replace(/\r\n/g, "\n");
  const crlf = lf.replace(/\n/g, "\r\n");
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  return [migration.hash, sha(lf), sha(crlf)];
}

/** Apply every migration in `migrationsFolder` whose hash is not yet recorded,
 * in journal order, inside one transaction. Returns how many were applied. */
export async function applyMigrations(
  client: MigrationClient,
  migrationsFolder: string,
): Promise<number> {
  const migrations = readMigrationFiles({ migrationsFolder });
  await client.query(`CREATE SCHEMA IF NOT EXISTS "drizzle"`);
  await client.query(
    `CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )`,
  );
  const { rows } = await client.query(`SELECT hash FROM "drizzle"."__drizzle_migrations"`);
  const recorded = new Set(rows.map((r) => String(r.hash)));
  const pending = migrations.filter((m) => !recordedForms(m).some((h) => recorded.has(h)));
  if (pending.length === 0) return 0;

  await client.query("BEGIN");
  try {
    for (const migration of pending) {
      for (const statement of migration.sql) {
        await client.query(statement);
      }
      await client.query(
        `INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ($1, $2)`,
        [migration.hash, migration.folderMillis],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
  return pending.length;
}
