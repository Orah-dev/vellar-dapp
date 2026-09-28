import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import {
  decodeVerificationCursor,
  encodeVerificationCursor,
  type VerificationRepository,
  type VerificationRecordInternal,
} from "../server";
import type { Db } from "./client";
import { verificationRecords } from "./schema";

const ACTIVE_STATUSES = ["submitted", "building"];

// Postgres implementation of the verification persistence seam. Shape and
// semantics must match createMemoryVerificationRepository exactly — the route
// tests define the contract. The whole record is stored as jsonb; scalar
// columns mirror the fields used for lookup/sort/claim.
export function createPgVerificationRepository(db: Db): VerificationRepository {
  return {
    async insert(record) {
      await db.insert(verificationRecords).values(toRow(record));
    },

    async find(id) {
      const rows = await db
        .select()
        .from(verificationRecords)
        .where(eq(verificationRecords.id, id))
        .limit(1);
      return rows[0]?.record;
    },

    async findByContract(contractId) {
      const rows = await db
        .select()
        .from(verificationRecords)
        .where(eq(verificationRecords.contractId, contractId))
        .orderBy(desc(verificationRecords.createdAt));
      return rows.map((r) => r.record);
    },

    async update(record) {
      await db
        .update(verificationRecords)
        .set({
          status: record.status,
          updatedAt: new Date(record.updatedAt),
          record,
        })
        .where(eq(verificationRecords.id, record.id));
    },
    async countActive() {
      const rows = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(verificationRecords)
        .where(inArray(verificationRecords.status, ACTIVE_STATUSES));
      return rows[0]?.n ?? 0;
    },
    async hasActiveForContract(contractId) {
      const rows = await db
        .select({ id: verificationRecords.id })
        .from(verificationRecords)
        .where(
          and(
            eq(verificationRecords.contractId, contractId),
            inArray(verificationRecords.status, ACTIVE_STATUSES),
          ),
        )
        .limit(1);
      return rows.length > 0;
    },
    async listPage(filter) {
      const conditions = [];
      if (filter.status) conditions.push(eq(verificationRecords.status, filter.status));

      if (filter.after) {
        const decoded = decodeVerificationCursor(filter.after);
        const afterCreatedAt = new Date(decoded.createdAt);
        // Keyset predicate for (createdAt DESC, id DESC): strictly older
        // createdAt, OR the same createdAt with a strictly smaller id,
        // matching the ORDER BY below exactly (see wallet-service's
        // activity_logs listPage and policy-service's policies listPage in
        // this same batch for the same reasoning).
        conditions.push(
          or(
            lt(verificationRecords.createdAt, afterCreatedAt),
            and(eq(verificationRecords.createdAt, afterCreatedAt), lt(verificationRecords.id, decoded.id)),
          ),
        );
      }

      const rows = await db
        .select()
        .from(verificationRecords)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(verificationRecords.createdAt), desc(verificationRecords.id))
        .limit(filter.limit + 1);

      const hasMore = rows.length > filter.limit;
      const page = hasMore ? rows.slice(0, filter.limit) : rows;
      const records = page.map((row) => row.record);
      const last = page[page.length - 1];
      return {
        records,
        hasMore,
        nextCursor:
          hasMore && last ? encodeVerificationCursor(last.createdAt.toISOString(), last.id) : undefined,
      };
    },
  };
}

function toRow(record: VerificationRecordInternal) {
  return {
    id: record.id,
    contractId: record.contractId,
    status: record.status,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
    record,
  };
}
