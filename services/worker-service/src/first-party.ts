import { normalizeHash } from "./artifact";

// The 2026-07-20 binding rule (README "Reproducibility model"): a FIRST-PARTY
// contract is built AND deployed through the canonical vela-verify image, so its
// deployed bytes ARE the image's output and verify byte-for-byte. The
// metadata-tolerant comparison (issue #419) exists for third-party authors who
// cannot use our image — it must never become a way for our own contracts to
// verify while drifting from the canonical build. So first-party verification
// stays exact-only.
//
// A contract is first-party when EITHER its deployed hash is one of our pinned
// canonical artifacts (keyed on the chain, not on anything a submitter controls)
// OR the submission claims a repo in our GitHub organization.

/** Canonical first-party wasm hashes. Mirrors the pins in
 * services/policy-service/src/templates.ts (a test keeps them in lockstep). */
export const FIRST_PARTY_WASM_HASHES: ReadonlySet<string> = new Set([
  // SPENDING_POLICY_WASM_HASH
  "0f6b858d61799a33efdc2303c60eb0c148fd2983b7d2336fc345b5492a24b791",
  // VERIFIED_RECIPIENT_WASM_HASH
  "a57efbf969d6e574e2b40d98985a145fd87d1760224ef6d10e268ea1f6080960",
]);

const FIRST_PARTY_GITHUB_OWNERS: ReadonlySet<string> = new Set(["vellar-wallet"]);

function githubOwner(repoUrl: string): string | undefined {
  try {
    const url = new URL(repoUrl);
    if (url.hostname.toLowerCase() !== "github.com") return undefined;
    return url.pathname.split("/").filter(Boolean)[0]?.toLowerCase();
  } catch {
    return undefined;
  }
}

export function isFirstPartyContract(input: { repoUrl?: string; deployedHash: string }): boolean {
  if (FIRST_PARTY_WASM_HASHES.has(normalizeHash(input.deployedHash))) return true;
  const owner = input.repoUrl ? githubOwner(input.repoUrl) : undefined;
  return owner !== undefined && FIRST_PARTY_GITHUB_OWNERS.has(owner);
}
