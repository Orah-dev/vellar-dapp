import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectDb, type DbHandle } from "./client";
import { createPgPolicyRepository } from "./pg-repository";
import { policies } from "./schema";
import type { PolicyRecord } from "../server";

// Integration tests against a real Postgres, matching wallet-service's
// pg-repository.test.ts convention. Skipped LOCALLY unless TEST_DATABASE_URL
// is set; CI provides a service container.
const DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!DATABASE_URL && process.env.CI_REQUIRE_DB === "1") {
  throw new Error(
    "CI_REQUIRE_DB=1 but TEST_DATABASE_URL is unset — DB integration tests would silently skip.",
  );
}

describe.skipIf(!DATABASE_URL)("pg policy repository", () => {
  let handle: DbHandle;

  beforeAll(async () => {
    handle = await connectDb(DATABASE_URL as string);
  });

  afterAll(async () => {
    await handle?.close();
  });

  beforeEach(async () => {
    await handle.db.delete(policies);
  });

  function record(overrides: Partial<PolicyRecord>): PolicyRecord {
    return {
      id: overrides.id ?? "id",
      createdAt: overrides.createdAt ?? new Date().toISOString(),
      status: overrides.status ?? "generated",
      definition: { version: "1", type: "spending_limit", owners: [] },
      policyHash: "hash",
      manifest: {
        template: "spending_limit",
        network: "testnet",
        enforcement: { kind: "policy-contract", wasmHash: "wasm" },
      },
      ...overrides,
    };
  }

  it("round-trips insert/find/update", async () => {
    const repo = createPgPolicyRepository(handle.db);
    const r = record({ id: "p1" });
    await repo.insert(r);
    expect(await repo.find("p1")).toEqual(r);

    const updated = { ...r, status: "deployed" as const };
    await repo.update(updated);
    expect(await repo.find("p1")).toEqual(updated);
  });

  describe("listPage (issue #257)", () => {
    it("filters by status and date range, paginating newest-first with no skip or duplicate", async () => {
      const repo = createPgPolicyRepository(handle.db);
      await repo.insert(record({ id: "p1", status: "deployed", createdAt: "2024-01-01T00:00:00.000Z" }));
      await repo.insert(record({ id: "p2", status: "generated", createdAt: "2024-01-02T00:00:00.000Z" }));
      await repo.insert(record({ id: "p3", status: "deployed", createdAt: "2024-01-03T00:00:00.000Z" }));
      await repo.insert(record({ id: "p4", status: "deployed", createdAt: "2024-06-01T00:00:00.000Z" }));

      const page = await repo.listPage({
        status: "deployed",
        createdAfter: "2024-01-01T00:00:00.000Z",
        createdBefore: "2024-02-01T00:00:00.000Z",
        limit: 10,
      });
      expect(page.policies.map((p) => p.id)).toEqual(["p3", "p1"]);
      expect(page.hasMore).toBe(false);
    });

    it("paginates across a full set with no skip or duplicate", async () => {
      const repo = createPgPolicyRepository(handle.db);
      for (let i = 0; i < 5; i++) {
        await repo.insert(record({ id: `p${i}`, createdAt: `2024-01-0${i + 1}T00:00:00.000Z` }));
      }

      const seen: string[] = [];
      let after: string | undefined;
      for (let i = 0; i < 10; i++) {
        const page = await repo.listPage({ limit: 2, after });
        expect(page.policies.length).toBeLessThanOrEqual(2);
        seen.push(...page.policies.map((p) => p.id));
        if (!page.hasMore) break;
        after = page.nextCursor;
      }
      expect(seen).toEqual(["p4", "p3", "p2", "p1", "p0"]);
    });

    it("tiebreaks by id when two rows share the exact same createdAt", async () => {
      const repo = createPgPolicyRepository(handle.db);
      const createdAt = "2024-06-01T00:00:00.000Z";
      await repo.insert(record({ id: "id-a", createdAt }));
      await repo.insert(record({ id: "id-b", createdAt }));

      const seen: string[] = [];
      let after: string | undefined;
      for (let i = 0; i < 10; i++) {
        const page = await repo.listPage({ limit: 1, after });
        expect(page.policies).toHaveLength(1);
        seen.push(page.policies[0]!.id);
        if (!page.hasMore) break;
        after = page.nextCursor;
      }
      expect(seen.sort()).toEqual(["id-a", "id-b"]);
    });

    it("rejects a malformed cursor rather than returning an arbitrary page", async () => {
      const repo = createPgPolicyRepository(handle.db);
      await expect(repo.listPage({ limit: 10, after: "not-a-real-cursor" })).rejects.toThrow();
    });

    it("returns an empty page (not an error) when nothing matches", async () => {
      const repo = createPgPolicyRepository(handle.db);
      const page = await repo.listPage({ status: "deployed", limit: 10 });
      expect(page).toEqual({ policies: [], hasMore: false, nextCursor: undefined });
    });
  });
});
