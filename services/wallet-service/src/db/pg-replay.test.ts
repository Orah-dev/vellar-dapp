import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import pg from "pg";
import { createPgSpendBudget, type PgBudgetConfig } from "@vellar/service-kit";
import { buildServer } from "../server";
import type { TransactionSubmitter } from "../relayer";
import { consumeSponsorBudget } from "../sponsor";
import {
  buildInvokeTx,
  KNOWN_WALLET,
  SECOND_WALLET,
  TESTNET_PASSPHRASE,
} from "../test-fixtures";
import { connectDb, type Db, type DbHandle } from "./client";
import { createPgAuditLog, createPgWalletRepository } from "./pg-repository";
import { createPgReplayGuard } from "./pg-replay";
import { activityLogs, wallets } from "./schema";
import { createTestDatabase, dropTestDatabase } from "./test-database";

// Replay protection against a REAL Postgres (issue #416). The concurrency
// guarantee rests on the submission_replay primary key, which only a real
// database enforces — a mock would make the concurrency test decorative (the
// RA-2 lesson). CI sets CI_REQUIRE_DB=1 so this fails rather than skips.
const DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!DATABASE_URL && process.env.CI_REQUIRE_DB === "1") {
  throw new Error(
    "CI_REQUIRE_DB=1 but TEST_DATABASE_URL is unset — the replay concurrency guarantee would silently skip.",
  );
}

const FEE = "12345";
const budgetConfig: PgBudgetConfig = {
  windowMs: 3_600_000,
  limits: {
    sponsor: { maxStroops: 500_000_000n, maxCount: 500 },
    deploy: { maxStroops: 200_000_000n, maxCount: 20 },
    create: { maxCount: 30 },
  },
};

describe.skipIf(!DATABASE_URL)("submission replay guard on Postgres", () => {
  let url: string;
  let handle: DbHandle;
  let db: Db;

  // Own database: this suite writes wallets/activity_logs/spend_ledger, which
  // pg-repository.test and pg-budget.test truncate from parallel workers.
  beforeAll(async () => {
    url = await createTestDatabase(DATABASE_URL as string, "replay");
    handle = await connectDb(url);
    db = handle.db;
  });

  afterAll(async () => {
    await handle?.close();
    if (url) await dropTestDatabase(DATABASE_URL as string, url);
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE submission_replay, spend_ledger`);
    await db.delete(activityLogs);
    await db.delete(wallets);
    for (const [keyId, contractId] of [
      ["k1", KNOWN_WALLET],
      ["k2", SECOND_WALLET],
    ] as const) {
      await db.insert(wallets).values({ keyId, contractId, network: "testnet", createdAt: new Date() });
    }
  });

  async function count(table: "submission_replay" | "spend_ledger"): Promise<number> {
    const res = await db.execute(sql.raw(`SELECT count(*)::int AS n FROM ${table}`));
    return (res as unknown as { rows: { n: number }[] }).rows[0]?.n ?? 0;
  }

  /** A sponsor-shaped submitter: consumes the REAL sponsor budget (as
   * createSponsorSubmitter does after simulation), then "sends". */
  function budgetedSubmitter(target: Db): TransactionSubmitter & { sends: number } {
    const budget = createPgSpendBudget(target, budgetConfig);
    const s = {
      sends: 0,
      async submit() {
        await consumeSponsorBudget(FEE, budget, "testnet");
        s.sends += 1;
        return { hash: `hash-${s.sends}` };
      },
    };
    return s;
  }

  function serverOn(target: Db, submitter: TransactionSubmitter) {
    return buildServer({
      submitter,
      networkPassphrase: TESTNET_PASSPHRASE,
      wallets: createPgWalletRepository(target),
      audit: createPgAuditLog(target),
      replayGuard: createPgReplayGuard(target, "testnet"),
    });
  }

  const submit = (app: ReturnType<typeof buildServer>, signedXdr: string) =>
    app.inject({ method: "POST", url: "/wallet/submit", payload: { signedXdr, network: "testnet" } });

  it("A: a replayed submission is rejected, is audited, and does not consume budget", async () => {
    const submitter = budgetedSubmitter(db);
    const app = serverOn(db, submitter);
    const signed = buildInvokeTx([{ subject: KNOWN_WALLET, nonce: "42", variant: "v2" }]);
    try {
      expect((await submit(app, signed)).statusCode).toBe(200);
      const replay = await submit(app, signed);
      expect(replay.statusCode).toBe(409);
      expect(replay.json().error).toBe("replayed_submission");
    } finally {
      await app.close();
    }
    expect(submitter.sends).toBe(1);
    expect(await count("spend_ledger")).toBe(1);
    expect(await count("submission_replay")).toBe(1);

    const events = await createPgAuditLog(db).list({ type: "tx.replay_rejected" });
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toMatchObject({ network: "testnet", subjects: [KNOWN_WALLET] });
    expect(events[0]?.data.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(events[0]?.data)).not.toContain(signed);
  });

  it("A': re-wrapping the same signed auth in a different envelope is still a replay", async () => {
    const submitter = budgetedSubmitter(db);
    const app = serverOn(db, submitter);
    const auth = [{ subject: KNOWN_WALLET, nonce: "7", variant: "v2" as const }];
    try {
      expect((await submit(app, buildInvokeTx(auth, { fee: "100", sequence: "1" }))).statusCode).toBe(200);
      const rewrapped = buildInvokeTx(auth, { fee: "999", sequence: "77" });
      expect((await submit(app, rewrapped)).statusCode).toBe(409);
    } finally {
      await app.close();
    }
    expect(await count("spend_ledger")).toBe(1);
  });

  it("B: identical concurrent submissions on independent connections — at most one accepted, budget charged once", async () => {
    // Each request path gets its OWN single-connection pool and its own server,
    // so the reservations genuinely race in Postgres (a shared pool would
    // serialize them and prove nothing — RA-2).
    const N = 8;
    const signed = buildInvokeTx([{ subject: KNOWN_WALLET, nonce: "9001", variant: "v2" }]);
    const paths = Array.from({ length: N }, () => {
      const pool = new pg.Pool({ connectionString: url, max: 1 });
      const target = drizzle(pool);
      const submitter = budgetedSubmitter(target);
      return { pool, submitter, app: serverOn(target, submitter) };
    });
    try {
      const results = await Promise.all(paths.map((p) => submit(p.app, signed)));
      const codes = results.map((r) => r.statusCode).sort();
      expect(codes.filter((c) => c === 200)).toHaveLength(1);
      expect(codes.filter((c) => c === 409)).toHaveLength(N - 1);
      expect(paths.reduce((n, p) => n + p.submitter.sends, 0)).toBe(1);
    } finally {
      await Promise.all(paths.map(async (p) => (await p.app.close(), await p.pool.end())));
    }
    expect(await count("spend_ledger")).toBe(1);
    expect(await count("submission_replay")).toBe(1);
  });

  it("C: distinct legitimate submissions are unaffected", async () => {
    const submitter = budgetedSubmitter(db);
    const app = serverOn(db, submitter);
    try {
      // Same wallet, different nonces (two signing ceremonies).
      expect((await submit(app, buildInvokeTx([{ subject: KNOWN_WALLET, nonce: "1" }]))).statusCode).toBe(200);
      expect((await submit(app, buildInvokeTx([{ subject: KNOWN_WALLET, nonce: "2" }]))).statusCode).toBe(200);
      // Same nonce value, different wallet — the nonce is per-address on-chain.
      expect((await submit(app, buildInvokeTx([{ subject: SECOND_WALLET, nonce: "1" }]))).statusCode).toBe(200);
    } finally {
      await app.close();
    }
    expect(submitter.sends).toBe(3);
    expect(await count("spend_ledger")).toBe(3);
  });

  it("all-or-nothing: a multi-signer tx with one spent nonce is rejected and leaves no partial reservation", async () => {
    const guard = createPgReplayGuard(db, "testnet");
    const spent = { address: SECOND_WALLET, nonce: "5", signatureExpirationLedger: 100 };
    expect(await guard.reserve([spent])).toEqual({ ok: true });
    const fresh = { address: KNOWN_WALLET, nonce: "6", signatureExpirationLedger: 100 };
    expect(await guard.reserve([fresh, spent])).toEqual({ ok: false, reason: "replay" });
    // The non-conflicting key was rolled back, so it can still be used.
    expect(await count("submission_replay")).toBe(1);
    expect(await guard.reserve([fresh])).toEqual({ ok: true });
  });

  it("partitions reservations by server-config network", async () => {
    const key = { address: KNOWN_WALLET, nonce: "3", signatureExpirationLedger: 100 };
    expect(await createPgReplayGuard(db, "testnet").reserve([key])).toEqual({ ok: true });
    expect(await createPgReplayGuard(db, "mainnet").reserve([key])).toEqual({ ok: true });
    expect(await createPgReplayGuard(db, "testnet").reserve([key])).toEqual({
      ok: false,
      reason: "replay",
    });
  });

  it("D: a reservation that fails to commit fails closed — no sponsorship, no budget, no replay row", async () => {
    // Wrap the real db so the reservation transaction does its INSERT and then
    // fails, exercising the actual rollback in Postgres.
    const failingCommit = {
      ...db,
      transaction: (fn: Parameters<Db["transaction"]>[0]) =>
        db.transaction(async (tx) => {
          await fn(tx);
          throw new Error("could not serialize access");
        }),
    } as unknown as Db;
    const submitter = budgetedSubmitter(db);
    const app = buildServer({
      submitter,
      networkPassphrase: TESTNET_PASSPHRASE,
      wallets: createPgWalletRepository(db),
      audit: createPgAuditLog(db),
      replayGuard: createPgReplayGuard(failingCommit, "testnet"),
    });
    try {
      const res = await submit(app, buildInvokeTx([{ subject: KNOWN_WALLET, nonce: "11" }]));
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe("replay_store_unavailable");
    } finally {
      await app.close();
    }
    expect(submitter.sends).toBe(0);
    expect(await count("spend_ledger")).toBe(0);
    expect(await count("submission_replay")).toBe(0);
  });

  it("D': an unreachable replay store refuses the submission", async () => {
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    await pool.end(); // every query now rejects
    const submitter = budgetedSubmitter(db);
    const app = buildServer({
      submitter,
      networkPassphrase: TESTNET_PASSPHRASE,
      wallets: createPgWalletRepository(db),
      replayGuard: createPgReplayGuard(drizzle(pool), "testnet"),
    });
    try {
      const res = await submit(app, buildInvokeTx([{ subject: KNOWN_WALLET, nonce: "12" }]));
      expect(res.statusCode).toBe(503);
    } finally {
      await app.close();
    }
    expect(submitter.sends).toBe(0);
    expect(await count("spend_ledger")).toBe(0);
  });

  it("purgeExpired removes only reservations whose auth can no longer validate on-chain", async () => {
    const guard = createPgReplayGuard(db, "testnet");
    await guard.reserve([
      { address: KNOWN_WALLET, nonce: "1", signatureExpirationLedger: 99 },
      { address: KNOWN_WALLET, nonce: "2", signatureExpirationLedger: 100 },
      { address: KNOWN_WALLET, nonce: "3", signatureExpirationLedger: 101 },
    ]);
    await createPgReplayGuard(db, "mainnet").reserve([
      { address: KNOWN_WALLET, nonce: "1", signatureExpirationLedger: 1 },
    ]);
    // Current ledger 100: an entry expiring AT ledger 100 is still valid.
    expect(await guard.purgeExpired(100)).toBe(1);
    expect(await count("submission_replay")).toBe(3);
    expect(await guard.reserve([{ address: KNOWN_WALLET, nonce: "2", signatureExpirationLedger: 100 }])).toEqual({
      ok: false,
      reason: "replay",
    });
  });
});
