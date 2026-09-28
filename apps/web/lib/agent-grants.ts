import { StrKey } from "@stellar/stellar-sdk";
import type { AgentPolicyGrant } from "vellar-sdk";

// Verified-only agent spending (issue #406; docs/design-phase8-payments.md).
//
// Decision: an agent key may NOT transact through unverified contracts unless
// the human explicitly opted that key out at mint time. Enforcement is
// on-chain: the verified-recipient policy is a REQUIRED CO-SIGNER in every
// grant of the agent key's SignerLimits, so the wallet's __check_auth runs it
// (against the attestation registry) on each context the agent authorizes.
// This module only builds that grant list for wallet.agents.mint — it decides
// nothing at payment time and is not itself the enforcement.
//
// Honesty bar: verified ≠ safe. "Verified" means the contract has
// reproducible, attributable source provenance per the attestation registry —
// not that it is audited, benign, or that the seller behind a payment is
// trustworthy. The gate checks the CONTRACTS the agent's auth entries invoke
// (e.g. the token in a transfer), not the human/G-account receiving funds.

export type AgentVerificationMode =
  { mode: "verified-only"; verifiedOnlyPolicy: string } | { mode: "unrestricted"; reason: string };

export interface AgentGrantInput {
  /** Token contract (C…) -> the spending-limit policy instance(s) budgeting it. */
  budgets: Record<string, string[]>;
  verification: AgentVerificationMode;
}

/** What the human approved, for the audit trail and the approval screen. */
export interface AgentTrustDecision {
  mode: AgentVerificationMode["mode"];
  tokens: string[];
  verifiedOnlyPolicy?: string;
  /** Required and non-empty for "unrestricted": the override is never implicit. */
  reason?: string;
}

export class AgentGrantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentGrantError";
  }
}

const MAX_REASON_LENGTH = 200;

function assertContract(id: string, what: string): void {
  if (!StrKey.isValidContract(id))
    throw new AgentGrantError(`${what} must be a contract address (C…).`);
}

export function buildAgentGrants(input: AgentGrantInput): {
  grants: AgentPolicyGrant[];
  decision: AgentTrustDecision;
} {
  const tokens = Object.keys(input.budgets);
  if (tokens.length === 0) throw new AgentGrantError("Grant the agent at least one token.");

  const v = input.verification;
  if (v.mode === "verified-only") {
    assertContract(v.verifiedOnlyPolicy, "The verified-only policy");
  } else {
    const reason = v.reason.trim();
    if (!reason) {
      throw new AgentGrantError("Turning off verified-only spending needs a stated reason.");
    }
    if (reason.length > MAX_REASON_LENGTH) {
      throw new AgentGrantError(`Keep the reason under ${MAX_REASON_LENGTH} characters.`);
    }
  }

  const grants = tokens.map((token) => {
    assertContract(token, "Each token");
    const budget = [...new Set(input.budgets[token] ?? [])];
    // A budget is mandatory: a grant whose only co-signer is the verified-only
    // policy would let the agent spend without limit through verified tokens.
    if (budget.length === 0) {
      throw new AgentGrantError("Every token needs a spending-limit policy.");
    }
    budget.forEach((p) => assertContract(p, "Each spending policy"));
    if (v.mode === "verified-only" && budget.includes(v.verifiedOnlyPolicy)) {
      throw new AgentGrantError("The verified-only policy can't double as a spending limit.");
    }
    return {
      token,
      policies: v.mode === "verified-only" ? [...budget, v.verifiedOnlyPolicy] : budget,
    };
  });

  const decision: AgentTrustDecision =
    v.mode === "verified-only"
      ? { mode: v.mode, tokens, verifiedOnlyPolicy: v.verifiedOnlyPolicy }
      : { mode: v.mode, tokens, reason: v.reason.trim() };
  return { grants, decision };
}

/** Approval-screen copy for the decision. Never claims "safe". */
export function describeAgentTrust(decision: AgentTrustDecision): string {
  if (decision.mode === "verified-only") {
    return (
      "This agent can only transact through contracts the attestation registry currently lists " +
      "as verified — checked on-chain every time it signs. Verified means the contract's source " +
      "provenance is reproducible, not that it is audited or safe, and it says nothing about who " +
      "receives the payment. If a legitimate resource is blocked, get its contract verified, pay " +
      "it yourself with your passkey, or re-issue this key without the restriction."
    );
  }
  return (
    "Verified-only spending is OFF for this agent: it can transact through unverified contracts, " +
    `within its spending limit. Your reason: "${decision.reason}". You can revoke the key at any time.`
  );
}
