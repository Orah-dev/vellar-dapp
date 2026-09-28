// @vitest-environment node

import { Asset, Networks } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  assetsFor,
  findAssetByContractId,
  findAssetById,
  findClassicAsset,
  nativeAsset,
} from "./assets";

const PASSPHRASE = { testnet: Networks.TESTNET, mainnet: Networks.PUBLIC } as const;

describe("token registry", () => {
  for (const network of ["testnet", "mainnet"] as const) {
    it(`${network}: every contract id is the SAC derived from its classic asset`, () => {
      for (const asset of assetsFor(network)) {
        const classic = asset.issuer ? new Asset(asset.code, asset.issuer) : Asset.native();
        expect(asset.contractId).toBe(classic.contractId(PASSPHRASE[network]));
        expect(asset.decimals).toBe(7);
      }
    });

    it(`${network}: ids and contract ids are unique`, () => {
      const assets = assetsFor(network);
      expect(new Set(assets.map((a) => a.id)).size).toBe(assets.length);
      expect(new Set(assets.map((a) => a.contractId)).size).toBe(assets.length);
    });
  }

  it("native asset is XLM with no issuer", () => {
    const xlm = nativeAsset("testnet");
    expect(xlm).toMatchObject({ id: "native", code: "XLM", symbol: "XLM" });
    expect(xlm.issuer).toBeUndefined();
  });

  it("resolves by id, contract id and classic pair", () => {
    const usdc = assetsFor("testnet")[1]!;
    expect(findAssetById("testnet", usdc.id)).toBe(usdc);
    expect(findAssetByContractId("testnet", usdc.contractId)).toBe(usdc);
    expect(findClassicAsset("testnet", "USDC", usdc.issuer!)).toBe(usdc);
  });

  it("rejects an impostor USDC from another issuer, and case variants", () => {
    const impostor = "GAHK7EEG2WWHVKDNT4CEQFZGKF2LGDSW2IVM4S5DP42RBW3K6BTODB4A";
    expect(findClassicAsset("testnet", "USDC", impostor)).toBeUndefined();
    expect(findClassicAsset("testnet", "usdc", assetsFor("testnet")[1]!.issuer!)).toBeUndefined();
  });

  it("does not resolve a testnet asset on mainnet", () => {
    const testUsdc = assetsFor("testnet")[1]!;
    expect(findAssetByContractId("mainnet", testUsdc.contractId)).toBeUndefined();
  });
});
