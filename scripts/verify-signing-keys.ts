#!/usr/bin/env tsx
/**
 * Signing-key network check (architecture-analysis.md §8 Q3).
 *
 * Confirms the sponsor / attestor ACCOUNTS a deployment is pinned to
 * (SPONSOR_PUBLIC_KEY / ATTESTOR_PUBLIC_KEY) actually live on the network the
 * deployment declares (STELLAR_NETWORK), and that the relayer URL agrees.
 *
 * The services already refuse to boot when a secret doesn't match its pin
 * (packages/service-kit/src/signing-keys.ts). This is the other half: it asks
 * BOTH public Horizons whether each pinned account exists, so an operator can
 * confirm — before a deploy, without ever handling a secret — that the pins
 * aren't testnet accounts left behind after the 2026-09-20 mainnet cutover.
 *
 * Takes PUBLIC keys only. Never pass a secret seed to this script.
 *
 * Usage:
 *   tsx scripts/verify-signing-keys.ts --network mainnet --sponsor G... --attestor G...
 *   tsx scripts/verify-signing-keys.ts --network mainnet --sponsor G... \
 *     --relayer-url https://channels.openzeppelin.com
 *   # or from env: STELLAR_NETWORK, SPONSOR_PUBLIC_KEY, ATTESTOR_PUBLIC_KEY, RELAYER_BASE_URL
 *
 * Exit codes:
 *   0  — every key exists on the declared network and the relayer agrees
 *   1  — at least one key is missing on the declared network (or only on the
 *        other one), a Horizon lookup failed, or the relayer disagrees
 *   2  — invalid arguments
 */

export type Network = "testnet" | "mainnet";

export const HORIZON: Record<Network, string> = {
  testnet: "https://horizon-testnet.stellar.org",
  mainnet: "https://horizon.stellar.org",
};

export interface KeyToCheck {
  role: string;
  publicKey: string;
}

export interface VerifyKeysOptions {
  network: Network;
  keys: KeyToCheck[];
  relayerUrl?: string;
  /** Minimum native (XLM) balance a key must hold on the declared network. Default 0. */
  minXlm?: number;
  horizon?: Partial<Record<Network, string>>;
  fetchImpl?: typeof fetch;
}

export type AccountLookup =
  | { status: "found"; xlm: number }
  | { status: "not_found" }
  | { status: "error"; detail: string };

export interface KeyResult {
  role: string;
  publicKey: string;
  declared: AccountLookup;
  other: AccountLookup;
  ok: boolean;
  verdict: string;
}

export interface VerifyKeysResult {
  ok: boolean;
  keys: KeyResult[];
  relayer?: { url: string; network: Network | undefined; ok: boolean; verdict: string };
}

const G_KEY = /^G[A-Z2-7]{55}$/;

/** Mirrors service-kit's relayerNetwork (kept local: scripts has no workspace deps). */
export function relayerNetwork(baseUrl: string): Network | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  const host = url.host.toLowerCase();
  const path = url.pathname.replace(/\/+$/, "").toLowerCase();
  if (host === "channels.openzeppelin.com") {
    if (path === "/testnet" || path.startsWith("/testnet/")) return "testnet";
    if (path === "" || path === "/mainnet" || path.startsWith("/mainnet/")) return "mainnet";
    return undefined;
  }
  const segments = path.split("/");
  if (segments.includes("testnet")) return "testnet";
  if (segments.includes("mainnet") || segments.includes("pubnet")) return "mainnet";
  return undefined;
}

async function lookupAccount(
  horizonUrl: string,
  publicKey: string,
  fetchImpl: typeof fetch,
): Promise<AccountLookup> {
  try {
    const res = await fetchImpl(`${horizonUrl.replace(/\/+$/, "")}/accounts/${publicKey}`);
    if (res.status === 404) return { status: "not_found" };
    if (!res.ok) return { status: "error", detail: `HTTP ${res.status}` };
    const body = (await res.json()) as { balances?: Array<{ asset_type: string; balance: string }> };
    const native = body.balances?.find((b) => b.asset_type === "native");
    return { status: "found", xlm: native ? Number(native.balance) : 0 };
  } catch (err) {
    return { status: "error", detail: err instanceof Error ? err.message : String(err) };
  }
}

function describe(lookup: AccountLookup): string {
  if (lookup.status === "found") return `found (${lookup.xlm} XLM)`;
  if (lookup.status === "not_found") return "not found";
  return `lookup failed: ${lookup.detail}`;
}

export async function verifySigningKeyNetworks(options: VerifyKeysOptions): Promise<VerifyKeysResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const minXlm = options.minXlm ?? 0;
  const otherNetwork: Network = options.network === "mainnet" ? "testnet" : "mainnet";
  const horizon = { ...HORIZON, ...options.horizon };

  const keys = await Promise.all(
    options.keys.map(async ({ role, publicKey }): Promise<KeyResult> => {
      const [declared, other] = await Promise.all([
        lookupAccount(horizon[options.network], publicKey, fetchImpl),
        lookupAccount(horizon[otherNetwork], publicKey, fetchImpl),
      ]);
      let ok = false;
      let verdict: string;
      if (declared.status === "found") {
        ok = declared.xlm >= minXlm;
        verdict = ok
          ? `OK — exists on ${options.network}`
          : `UNDERFUNDED — ${declared.xlm} XLM on ${options.network}, need >= ${minXlm}`;
      } else if (declared.status === "not_found" && other.status === "found") {
        verdict = `WRONG NETWORK — exists on ${otherNetwork} but not on ${options.network}`;
      } else if (declared.status === "not_found") {
        verdict = `NOT FOUND — no account on ${options.network} (unfunded or wrong key)`;
      } else {
        verdict = `UNCONFIRMED — ${describe(declared)}`;
      }
      return { role, publicKey, declared, other, ok, verdict };
    }),
  );

  let relayer: VerifyKeysResult["relayer"];
  if (options.relayerUrl) {
    const net = relayerNetwork(options.relayerUrl);
    const ok = net === options.network;
    relayer = {
      url: options.relayerUrl,
      network: net,
      ok,
      verdict: ok
        ? `OK — ${options.network}`
        : net
          ? `WRONG NETWORK — looks like ${net}`
          : "UNCONFIRMED — unrecognized relayer URL; check it by hand",
    };
  }

  return { ok: keys.every((k) => k.ok) && (relayer?.ok ?? true), keys, relayer };
}

interface ParsedArgs {
  network?: string;
  sponsor?: string;
  attestor?: string;
  relayerUrl?: string;
  minXlm?: number;
}

function parseArgs(argv: string[], env: NodeJS.ProcessEnv): ParsedArgs {
  const out: ParsedArgs = {
    network: env.STELLAR_NETWORK,
    sponsor: env.SPONSOR_PUBLIC_KEY,
    attestor: env.ATTESTOR_PUBLIC_KEY,
    relayerUrl: env.RELAYER_BASE_URL,
  };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i + 1];
    switch (argv[i]) {
      case "--network":
        out.network = value;
        i++;
        break;
      case "--sponsor":
        out.sponsor = value;
        i++;
        break;
      case "--attestor":
        out.attestor = value;
        i++;
        break;
      case "--relayer-url":
        out.relayerUrl = value;
        i++;
        break;
      case "--min-xlm":
        out.minXlm = Number(value);
        i++;
        break;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2), process.env);
  if (args.network !== "testnet" && args.network !== "mainnet") {
    console.error("--network (or STELLAR_NETWORK) must be 'testnet' or 'mainnet'.");
    process.exit(2);
  }
  const keys: KeyToCheck[] = [];
  for (const [role, value] of [
    ["sponsor", args.sponsor],
    ["attestor", args.attestor],
  ] as const) {
    if (!value) continue;
    if (value.startsWith("S")) {
      console.error(`--${role} looks like a SECRET seed. Pass the public (G...) key only.`);
      process.exit(2);
    }
    if (!G_KEY.test(value)) {
      console.error(`--${role} '${value}' is not a Stellar public key (G..., 56 chars).`);
      process.exit(2);
    }
    keys.push({ role, publicKey: value });
  }
  if (keys.length === 0) {
    console.error("Pass at least one of --sponsor / --attestor (or SPONSOR_PUBLIC_KEY / ATTESTOR_PUBLIC_KEY).");
    process.exit(2);
  }
  if (args.minXlm !== undefined && !(Number.isFinite(args.minXlm) && args.minXlm >= 0)) {
    console.error("--min-xlm must be a non-negative number.");
    process.exit(2);
  }

  const result = await verifySigningKeyNetworks({
    network: args.network,
    keys,
    relayerUrl: args.relayerUrl,
    minXlm: args.minXlm,
  });

  console.log(`Declared network: ${args.network}`);
  for (const k of result.keys) {
    console.log(`  ${k.role.padEnd(8)} ${k.publicKey}  ${k.verdict}`);
    const other = args.network === "mainnet" ? "testnet" : "mainnet";
    console.log(`           ${args.network}: ${describe(k.declared)}; ${other}: ${describe(k.other)}`);
  }
  if (result.relayer) {
    console.log(`  relayer  ${result.relayer.url}  ${result.relayer.verdict}`);
  }
  console.log(result.ok ? "PASS" : "FAIL");
  process.exit(result.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
