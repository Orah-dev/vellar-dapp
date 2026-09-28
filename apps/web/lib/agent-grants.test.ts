// @vitest-environment node

import { StrKey } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { buildAgentGrants, describeAgentTrust } from "./agent-grants";

const c = (n: number) => StrKey.encodeContract(Buffer.alloc(32, n));
const USDC = c(1);
const XLM = c(2);
const BUDGET_USDC = c(3);
const BUDGET_XLM = c(4);
const VERIFIED = c(5);

describe("buildAgentGrants — verified-only (default policy)", () => {
  it("adds the verified-only policy as a required co-signer on every grant", () => {
    const { grants, decision } = buildAgentGrants({
      budgets: { [USDC]: [BUDGET_USDC], [XLM]: [BUDGET_XLM] },
      verification: { mode: "verified-only", verifiedOnlyPolicy: VERIFIED },
    });
    expect(grants).toEqual([
      { token: USDC, policies: [BUDGET_USDC, VERIFIED] },
      { token: XLM, policies: [BUDGET_XLM, VERIFIED] },
    ]);
    expect(decision).toEqual({
      mode: "verified-only",
      tokens: [USDC, XLM],
      verifiedOnlyPolicy: VERIFIED,
    });
  });

  it("never produces a grant whose only co-signer is the verified-only policy", () => {
    expect(() =>
      buildAgentGrants({
        budgets: { [USDC]: [] },
        verification: { mode: "verified-only", verifiedOnlyPolicy: VERIFIED },
      }),
    ).toThrow(/spending-limit/);
  });

  it("dedupes budget policies and refuses the gate doubling as a budget", () => {
    const { grants } = buildAgentGrants({
      budgets: { [USDC]: [BUDGET_USDC, BUDGET_USDC] },
      verification: { mode: "verified-only", verifiedOnlyPolicy: VERIFIED },
    });
    expect(grants[0]?.policies).toEqual([BUDGET_USDC, VERIFIED]);
    expect(() =>
      buildAgentGrants({
        budgets: { [USDC]: [VERIFIED] },
        verification: { mode: "verified-only", verifiedOnlyPolicy: VERIFIED },
      }),
    ).toThrow(/double/);
  });

  it.each([
    [{ budgets: {} }, /at least one token/],
    [{ budgets: { GABC: [BUDGET_USDC] } }, /token/i],
    [{ budgets: { [USDC]: ["not-a-contract"] } }, /spending policy/],
  ])("rejects malformed input %#", (partial, message) => {
    expect(() =>
      buildAgentGrants({
        verification: { mode: "verified-only", verifiedOnlyPolicy: VERIFIED },
        ...partial,
      }),
    ).toThrow(message);
  });

  it("rejects a malformed verified-only policy id", () => {
    expect(() =>
      buildAgentGrants({
        budgets: { [USDC]: [BUDGET_USDC] },
        verification: { mode: "verified-only", verifiedOnlyPolicy: "Cnope" },
      }),
    ).toThrow(/verified-only policy/);
  });
});

describe("buildAgentGrants — explicit override", () => {
  it("drops the gate only with a stated reason, and records it", () => {
    const { grants, decision } = buildAgentGrants({
      budgets: { [USDC]: [BUDGET_USDC] },
      verification: { mode: "unrestricted", reason: "  Paying our own unverified test contract  " },
    });
    expect(grants).toEqual([{ token: USDC, policies: [BUDGET_USDC] }]);
    expect(decision).toEqual({
      mode: "unrestricted",
      tokens: [USDC],
      reason: "Paying our own unverified test contract",
    });
  });

  it.each(["", "   ", "x".repeat(201)])("refuses an override with reason %j", (reason) => {
    expect(() =>
      buildAgentGrants({
        budgets: { [USDC]: [BUDGET_USDC] },
        verification: { mode: "unrestricted", reason },
      }),
    ).toThrow(/reason/);
  });

  it("keeps the spending limit even when verification is off", () => {
    expect(() =>
      buildAgentGrants({
        budgets: { [USDC]: [] },
        verification: { mode: "unrestricted", reason: "r" },
      }),
    ).toThrow(/spending-limit/);
  });
});

describe("describeAgentTrust — honesty bar", () => {
  const verified = describeAgentTrust({
    mode: "verified-only",
    tokens: [USDC],
    verifiedOnlyPolicy: VERIFIED,
  });
  const override = describeAgentTrust({ mode: "unrestricted", tokens: [USDC], reason: "testing" });

  it("never equates verified with safe", () => {
    for (const copy of [verified, override]) {
      expect(copy).not.toMatch(/\b(is|are|it's|as) safe\b/i);
      expect(copy).not.toMatch(/\bsafe (to|contract|resource)/i);
    }
    expect(verified).toMatch(/not that it is audited or safe/);
  });

  it("states the scope limit and the recovery paths", () => {
    expect(verified).toMatch(/nothing about who receives the payment/);
    expect(verified).toMatch(/get its contract verified/);
    expect(verified).toMatch(/pay it yourself with your passkey/);
    expect(verified).toMatch(/re-issue this key/);
  });

  it("makes the override and its reason visible", () => {
    expect(override).toMatch(/OFF/);
    expect(override).toMatch(/"testing"/);
  });
});
