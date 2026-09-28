import type { Network } from "@vellar/types";
import { MAINNET, TESTNET, type NetworkConfig, type TokenInfo } from "vellar-sdk";

// Token registry (technical-doc.md §17.2, open-work-catalogue 2.1): the
// canonical list of assets the wallet will hold, show, request (SEP-7) and
// swap. Every surface that accepts an asset from outside — a pasted SEP-7
// URI, a swap pair — resolves it HERE and rejects anything unregistered, so an
// impostor "USDC" from another issuer can never be requested or swapped.
//
// Deliberately minimal: XLM + Circle USDC, the two assets the stack already
// settles in. Contract ids come from vellar-sdk's NetworkConfig (derived from
// the issuer, so they cannot drift from the classic asset they wrap).

export interface RegisteredAsset extends TokenInfo {
  /** Stable key: "native" or "CODE:ISSUER". */
  id: string;
  name: string;
  /** Classic asset code; "XLM" for the native asset. */
  code: string;
  /** Classic issuer (G…); absent for the native asset. */
  issuer?: string;
}

const STELLAR_DECIMALS = 7;

function registryFor(config: NetworkConfig): RegisteredAsset[] {
  return [
    {
      id: "native",
      name: "Stellar Lumens",
      code: "XLM",
      symbol: "XLM",
      contractId: config.nativeTokenContractId,
      decimals: STELLAR_DECIMALS,
    },
    {
      id: `USDC:${config.usdcIssuer}`,
      name: "USD Coin",
      code: "USDC",
      issuer: config.usdcIssuer,
      symbol: "USDC",
      contractId: config.usdcContractId,
      decimals: STELLAR_DECIMALS,
    },
  ];
}

const REGISTRY: Record<Network, RegisteredAsset[]> = {
  testnet: registryFor(TESTNET),
  mainnet: registryFor(MAINNET),
};

export function assetsFor(network: Network): RegisteredAsset[] {
  return REGISTRY[network];
}

export function nativeAsset(network: Network): RegisteredAsset {
  return REGISTRY[network][0] as RegisteredAsset;
}

export function findAssetById(network: Network, id: string): RegisteredAsset | undefined {
  return REGISTRY[network].find((a) => a.id === id);
}

export function findAssetByContractId(
  network: Network,
  contractId: string,
): RegisteredAsset | undefined {
  return REGISTRY[network].find((a) => a.contractId === contractId);
}

/** Resolve a classic (code, issuer) pair. Codes compare exactly — "usdc" is not "USDC". */
export function findClassicAsset(
  network: Network,
  code: string,
  issuer: string,
): RegisteredAsset | undefined {
  return REGISTRY[network].find((a) => a.code === code && a.issuer === issuer);
}
