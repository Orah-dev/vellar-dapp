import { and, eq, lt } from "drizzle-orm";
import type { BudgetNetwork } from "@vellar/service-kit";
import type { ReplayGuard, ReplayKey } from "../replay";
import type { Db } from "./client";
import { submissionReplay } from "./schema";

// Postgres replay guard (issue #416). See src/replay.ts for the replay model.
//
// Concurrency: unlike the spend budget (RA-2), this is not an aggregate
// check-then-insert, so it needs no advisory lock. The PRIMARY KEY is the
// arbiter: INSERT ... ON CONFLICT DO NOTHING on a key another in-flight
// transaction has inserted BLOCKS on the unique index until that transaction
// ends, then either conflicts (it committed) or inserts (it rolled back). Two
// concurrent identical submissions therefore cannot both reserve, at any
// isolation level.
//
// All-or-nothing: a submission's keys are reserved in ONE transaction. If any
// key conflicts, the transaction is rolled back so no partial reservation is
// left behind to block the non-conflicting nonces.
//
// Network is SERVER CONFIG (the budget network), never a request body (V5).

class ReplayConflict extends Error {}

export function createPgReplayGuard(db: Db, network: BudgetNetwork, now: () => Date = () => new Date()): ReplayGuard & {
  /** Delete reservations whose auth can no longer validate on-chain (every
   * expiration ledger strictly below `currentLedger`). Returns rows removed. */
  purgeExpired(currentLedger: number): Promise<number>;
} {
  return {
    async reserve(keys: ReplayKey[]) {
      if (keys.length === 0) return { ok: true };
      const reservedAt = now();
      try {
        await db.transaction(async (tx) => {
          const inserted = await tx
            .insert(submissionReplay)
            .values(
              keys.map((k) => ({
                network,
                address: k.address,
                nonce: k.nonce,
                expirationLedger: k.signatureExpirationLedger,
                reservedAt,
              })),
            )
            .onConflictDoNothing()
            .returning({ nonce: submissionReplay.nonce });
          if (inserted.length !== keys.length) throw new ReplayConflict();
        });
      } catch (err) {
        if (err instanceof ReplayConflict) return { ok: false, reason: "replay" };
        throw err; // DB failure: the caller refuses (fail closed)
      }
      return { ok: true };
    },

    async release(keys: ReplayKey[]) {
      for (const k of keys) {
        await db
          .delete(submissionReplay)
          .where(
            and(
              eq(submissionReplay.network, network),
              eq(submissionReplay.address, k.address),
              eq(submissionReplay.nonce, k.nonce),
            ),
          );
      }
    },

    async purgeExpired(currentLedger: number) {
      const deleted = await db
        .delete(submissionReplay)
        .where(
          and(
            eq(submissionReplay.network, network),
            lt(submissionReplay.expirationLedger, currentLedger),
          ),
        )
        .returning({ nonce: submissionReplay.nonce });
      return deleted.length;
    },
  };
}
