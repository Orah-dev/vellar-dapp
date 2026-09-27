import { and, desc, eq, gte, lt, lte, or } from "drizzle-orm";
import {
  decodePolicyCursor,
  encodePolicyCursor,
  type PolicyRecord,
  type PolicyRepository,
} from "../server";
import type { Db } from "./client";
import { policies } from "./schema";

// Postgres implementation of the policy persistence seam. Shape and semantics
// must match createMemoryPolicyRepository exactly — the route tests define the
// contract. The whole record is stored as jsonb; id/status/createdAt are
// mirrored into scalar columns for inspection.
export function createPgPolicyRepository(db: Db): PolicyRepository {
  return {
    async insert(record) {
      await db.insert(policies).values(toRow(record));
    },

    async find(id) {
      const rows = await db.select().from(policies).where(eq(policies.id, id)).limit(1);
      return rows[0]?.record;
    },

    async update(record) {
      await db
        .update(policies)
        .set({ status: record.status, record })
        .where(eq(policies.id, record.id));
    },

    async listPage(filter) {
      const conditions = [];
      if (filter.status) conditions.push(eq(policies.status, filter.status));
      if (filter.createdAfter) conditions.push(gte(policies.createdAt, new Date(filter.createdAfter)));
      if (filter.createdBefore) conditions.push(lte(policies.createdAt, new Date(filter.createdBefore)));

      if (filter.after) {
        const decoded = decodePolicyCursor(filter.after);
        const afterCreatedAt = new Date(decoded.createdAt);
        // Keyset predicate for (createdAt DESC, id DESC): strictly older
        // createdAt, OR the same createdAt with a strictly smaller id —
        // matches the ORDER BY below exactly (see wallet-service's
        // activity_logs listPage for the same reasoning).
        conditions.push(
          or(
            lt(policies.createdAt, afterCreatedAt),
            and(eq(policies.createdAt, afterCreatedAt), lt(policies.id, decoded.id)),
          ),
        );
      }

      const rows = await db
        .select()
        .from(policies)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(policies.createdAt), desc(policies.id))
        .limit(filter.limit + 1);

      const hasMore = rows.length > filter.limit;
      const page = hasMore ? rows.slice(0, filter.limit) : rows;
      const records = page.map((row) => row.record);
      const last = page[page.length - 1];
      return {
        policies: records,
        hasMore,
        nextCursor:
          hasMore && last ? encodePolicyCursor(last.createdAt.toISOString(), last.id) : undefined,
      };
    },
  };
}

function toRow(record: PolicyRecord) {
  return {
    id: record.id,
    status: record.status,
    createdAt: new Date(record.createdAt),
    record,
  };
}
