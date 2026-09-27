import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { Account, Keypair, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { createMemoryAuditLog, createMemoryWalletRepository } from "./repository";
import { SubmissionError, type TransactionSubmitter } from "./relayer";
import {
  createMemoryReplayGuard,
  extractReplayKeys,
  RELEASABLE_SUBMISSION_CODES,
  replayFingerprint,
  type ReplayGuard,
} from "./replay";
import { buildServer } from "./server";
import { buildInvokeTx, KNOWN_WALLET, SECOND_WALLET, TESTNET_PASSPHRASE } from "./test-fixtures";

describe("extractReplayKeys", () => {
  it("keys each address-credential entry on (address, nonce) with its expiration", () => {
    const signed = buildInvokeTx([
      { subject: KNOWN_WALLET, nonce: "-9223372036854775808", expirationLedger: 500, variant: "v2" },
      { subject: SECOND_WALLET, nonce: "9223372036854775807", expirationLedger: 600 },
    ]);
    expect(extractReplayKeys(signed, TESTNET_PASSPHRASE)).toEqual([
      { address: KNOWN_WALLET, nonce: "-9223372036854775808", signatureExpirationLedger: 500 },
      { address: SECOND_WALLET, nonce: "9223372036854775807", signatureExpirationLedger: 600 },
    ]);
  });

  it("is independent of the envelope (source, sequence, fee) the sponsor discards", () => {
    const auth = [{ subject: KNOWN_WALLET, nonce: "77", variant: "v2" as const }];
    const a = buildInvokeTx(auth, { fee: "100", sequence: "1" });
    const b = buildInvokeTx(auth, { fee: "5000", sequence: "900" });
    expect(a).not.toBe(b);
    expect(extractReplayKeys(a, TESTNET_PASSPHRASE)).toEqual(
      extractReplayKeys(b, TESTNET_PASSPHRASE),
    );
  });

  it("de-duplicates a repeated (address, nonce)", () => {
    const signed = buildInvokeTx([
      { subject: KNOWN_WALLET, nonce: "1" },
      { subject: KNOWN_WALLET, nonce: "1" },
    ]);
    expect(extractReplayKeys(signed, TESTNET_PASSPHRASE)).toHaveLength(1);
  });

  it("returns [] for junk, a wrong passphrase, or a tx with no address credentials", () => {
    expect(extractReplayKeys("not-xdr", TESTNET_PASSPHRASE)).toEqual([]);
    const classic = new TransactionBuilder(new Account(Keypair.random().publicKey(), "1"), {
      fee: "100",
      networkPassphrase: TESTNET_PASSPHRASE,
    })
      .addOperation(Operation.bumpSequence({ bumpTo: "5" }))
      .setTimeout(30)
      .build()
      .toXDR();
    expect(extractReplayKeys(classic, TESTNET_PASSPHRASE)).toEqual([]);
  });
});

describe("replayFingerprint", () => {
  it("is order-independent and does not embed the raw keys", () => {
    const k1 = { address: KNOWN_WALLET, nonce: "1", signatureExpirationLedger: 1 };
    const k2 = { address: SECOND_WALLET, nonce: "2", signatureExpirationLedger: 1 };
    expect(replayFingerprint([k1, k2])).toBe(replayFingerprint([k2, k1]));
    expect(replayFingerprint([k1, k2])).toMatch(/^[0-9a-f]{16}$/);
    expect(replayFingerprint([k1])).not.toBe(replayFingerprint([k2]));
  });
});

describe("createMemoryReplayGuard", () => {
  it("reserves all-or-nothing and releases", async () => {
    const guard = createMemoryReplayGuard();
    const a = { address: KNOWN_WALLET, nonce: "1", signatureExpirationLedger: 1 };
    const b = { address: KNOWN_WALLET, nonce: "2", signatureExpirationLedger: 1 };
    expect(await guard.reserve([a])).toEqual({ ok: true });
    expect(await guard.reserve([b, a])).toEqual({ ok: false, reason: "replay" });
    expect(await guard.reserve([b])).toEqual({ ok: true }); // b was not left reserved
    await guard.release([a]);
    expect(await guard.reserve([a])).toEqual({ ok: true });
  });
});

describe("POST /wallet/submit replay protection (#416)", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function serverWith(submitter: TransactionSubmitter, replayGuard?: ReplayGuard) {
    const wallets = createMemoryWalletRepository();
    for (const [keyId, contractId] of [
      ["k1", KNOWN_WALLET],
      ["k2", SECOND_WALLET],
    ] as const) {
      await wallets.insert({ keyId, contractId, network: "testnet", createdAt: new Date().toISOString() });
    }
    const audit = createMemoryAuditLog();
    app = buildServer({ submitter, wallets, audit, networkPassphrase: TESTNET_PASSPHRASE, replayGuard });
    return { server: app, audit };
  }

  const post = (server: FastifyInstance, signedXdr: string, network = "testnet") =>
    server.inject({ method: "POST", url: "/wallet/submit", payload: { signedXdr, network } });

  it("rejects the second submission of the same signed auth with 409, before the submitter", async () => {
    const submit = vi.fn().mockResolvedValue({ hash: "h" });
    const { server, audit } = await serverWith({ submit });
    const signed = buildInvokeTx([{ subject: KNOWN_WALLET, nonce: "10", variant: "v2" }]);
    expect((await post(server, signed)).statusCode).toBe(200);
    const replay = await post(server, signed);
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toEqual({
      error: "replayed_submission",
      message: "This signed authorization has already been submitted.",
    });
    expect(submit).toHaveBeenCalledTimes(1);
    const [event] = await audit.list({ type: "tx.replay_rejected" });
    expect(event?.data).toMatchObject({ network: "testnet", subjects: [KNOWN_WALLET] });
    expect(JSON.stringify(event?.data)).not.toContain(signed);
  });

  it("a tx sharing ANY spent nonce is a replay, even alongside a fresh one", async () => {
    const { server } = await serverWith({ submit: vi.fn().mockResolvedValue({ hash: "h" }) });
    expect((await post(server, buildInvokeTx([{ subject: KNOWN_WALLET, nonce: "1" }]))).statusCode).toBe(200);
    const mixed = buildInvokeTx([
      { subject: SECOND_WALLET, nonce: "50" },
      { subject: KNOWN_WALLET, nonce: "1" },
    ]);
    expect((await post(server, mixed)).statusCode).toBe(409);
  });

  it("releases the reservation when the failure provably preceded any send", async () => {
    const submit = vi
      .fn()
      .mockRejectedValueOnce(new SubmissionError("sim failed", "sponsor_simulation_failed"))
      .mockResolvedValueOnce({ hash: "h" });
    const { server } = await serverWith({ submit });
    const signed = buildInvokeTx([{ subject: KNOWN_WALLET, nonce: "20" }]);
    expect((await post(server, signed)).statusCode).toBe(502);
    expect((await post(server, signed)).statusCode).toBe(200);
  });

  it.each(["tx_timeout", "tx_failed", "sponsor_submit_failed", "relayer_error"])(
    "keeps the reservation after %s (the tx may have reached the network)",
    async (code) => {
      const submit = vi.fn().mockRejectedValueOnce(new SubmissionError("x", code));
      const { server } = await serverWith({ submit });
      const signed = buildInvokeTx([{ subject: KNOWN_WALLET, nonce: "30" }]);
      expect((await post(server, signed)).statusCode).toBe(502);
      expect((await post(server, signed)).statusCode).toBe(409);
      expect(submit).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps the reservation after a non-SubmissionError (unknown send state)", async () => {
    const submit = vi.fn().mockRejectedValueOnce(new Error("socket hang up"));
    const { server } = await serverWith({ submit });
    const signed = buildInvokeTx([{ subject: KNOWN_WALLET, nonce: "31" }]);
    expect((await post(server, signed)).statusCode).toBe(502);
    expect((await post(server, signed)).statusCode).toBe(409);
  });

  it("only pre-send codes are releasable", () => {
    for (const code of ["tx_timeout", "tx_failed", "sponsor_submit_failed", "submission_failed"]) {
      expect(RELEASABLE_SUBMISSION_CODES.has(code)).toBe(false);
    }
  });

  it("fails closed (503, submitter not called) when the replay store throws", async () => {
    const submit = vi.fn().mockResolvedValue({ hash: "h" });
    const { server } = await serverWith(
      { submit },
      {
        reserve: async () => {
          throw new Error("connection terminated");
        },
        release: async () => {},
      },
    );
    const res = await post(server, buildInvokeTx([{ subject: KNOWN_WALLET, nonce: "40" }]));
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("replay_store_unavailable");
    expect(submit).not.toHaveBeenCalled();
  });

  it("still rejects a replay when the audit write fails", async () => {
    const { server, audit } = await serverWith({ submit: vi.fn().mockResolvedValue({ hash: "h" }) });
    const signed = buildInvokeTx([{ subject: KNOWN_WALLET, nonce: "41" }]);
    expect((await post(server, signed)).statusCode).toBe(200);
    audit.record = async () => {
      throw new Error("audit down");
    };
    expect((await post(server, signed)).statusCode).toBe(409);
  });

  it("does not reserve for an unscoped tx (scope rejects first, table cannot be filled)", async () => {
    const reserve = vi.fn().mockResolvedValue({ ok: true });
    const { server } = await serverWith(
      { submit: vi.fn().mockResolvedValue({ hash: "h" }) },
      { reserve, release: async () => {} },
    );
    const stranger = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";
    expect((await post(server, buildInvokeTx([{ subject: stranger, nonce: "1" }]))).statusCode).toBe(403);
    expect(reserve).not.toHaveBeenCalled();
  });
});
