import { describe, expect, it } from "vitest";
import { IdempotencyStore } from "./idempotency-store";

describe("IdempotencyStore (issue #260)", () => {
  it("misses on an unknown key", () => {
    const store = new IdempotencyStore();
    expect(store.lookup("key-1", "hash-a")).toEqual({ kind: "miss" });
  });

  it("hits on a repeated key with the SAME payload", () => {
    const store = new IdempotencyStore();
    const record = {
      payloadHash: "hash-a",
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: '{"hash":"tx123"}',
      recordedAt: Date.now(),
    };
    store.record("key-1", record);

    const result = store.lookup("key-1", "hash-a");
    expect(result).toEqual({ kind: "hit", record });
  });

  it("reports a conflict on a repeated key with a DIFFERING payload", () => {
    const store = new IdempotencyStore();
    store.record("key-1", {
      payloadHash: "hash-a",
      statusCode: 200,
      headers: {},
      body: "{}",
      recordedAt: Date.now(),
    });

    const result = store.lookup("key-1", "hash-b");
    expect(result).toEqual({ kind: "conflict" });
  });

  it("never serves a hit for an expired record (treats it as a miss)", () => {
    const store = new IdempotencyStore({ ttlMs: 1000 });
    const recordedAt = Date.now();
    store.record("key-1", { payloadHash: "hash-a", statusCode: 200, headers: {}, body: "{}", recordedAt });

    const stillFresh = store.lookup("key-1", "hash-a", recordedAt + 500);
    expect(stillFresh.kind).toBe("hit");

    const expired = store.lookup("key-1", "hash-a", recordedAt + 1001);
    expect(expired).toEqual({ kind: "miss" });
  });

  it("an expired record does not count as a conflict either, even with a different payload", () => {
    const store = new IdempotencyStore({ ttlMs: 1000 });
    const recordedAt = Date.now();
    store.record("key-1", { payloadHash: "hash-a", statusCode: 200, headers: {}, body: "{}", recordedAt });

    // Different payload hash AND expired: miss wins, not conflict, since the
    // old record has fully aged out.
    const result = store.lookup("key-1", "hash-b", recordedAt + 1001);
    expect(result).toEqual({ kind: "miss" });
  });

  it("pruneExpired removes only expired entries and reports the count", () => {
    const store = new IdempotencyStore({ ttlMs: 1000 });
    const now = Date.now();
    store.record("fresh", { payloadHash: "h", statusCode: 200, headers: {}, body: "{}", recordedAt: now });
    store.record("stale-1", { payloadHash: "h", statusCode: 200, headers: {}, body: "{}", recordedAt: now - 2000 });
    store.record("stale-2", { payloadHash: "h", statusCode: 200, headers: {}, body: "{}", recordedAt: now - 5000 });

    expect(store.size).toBe(3);
    const pruned = store.pruneExpired(now);
    expect(pruned).toBe(2);
    expect(store.size).toBe(1);
    expect(store.lookup("fresh", "h", now)).toMatchObject({ kind: "hit" });
    expect(store.lookup("stale-1", "h", now)).toEqual({ kind: "miss" });
  });

  it("different keys are fully independent", () => {
    const store = new IdempotencyStore();
    store.record("key-a", { payloadHash: "h", statusCode: 201, headers: {}, body: "a", recordedAt: Date.now() });
    store.record("key-b", { payloadHash: "h", statusCode: 202, headers: {}, body: "b", recordedAt: Date.now() });

    expect((store.lookup("key-a", "h") as { kind: "hit"; record: { statusCode: number } }).record.statusCode).toBe(
      201,
    );
    expect((store.lookup("key-b", "h") as { kind: "hit"; record: { statusCode: number } }).record.statusCode).toBe(
      202,
    );
  });
});
