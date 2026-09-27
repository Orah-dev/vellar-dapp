import { randomUUID } from "node:crypto";
import pg from "pg";

// Test-only: throwaway databases on the TEST_DATABASE_URL server, so suites that
// truncate shared tables cannot race each other across vitest workers.

/** Create an empty database and return its connection URL. */
export async function createTestDatabase(baseUrl: string, prefix: string): Promise<string> {
  const name = `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

export async function dropTestDatabase(baseUrl: string, databaseUrl: string): Promise<void> {
  const name = new URL(databaseUrl).pathname.slice(1);
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}
