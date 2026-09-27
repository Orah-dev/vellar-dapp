# Design: Phase 8 payments — receive/SEP-7, swaps, verified-only agents, type-2 credentials

Decisions for issues #402, #404, #406 and #407, recorded 2026-09-25. `docs/decisions.md`
and `technical-doc.md` are private (gitignored), so the entries live here for a
maintainer to mirror into them.

## #407 — Swaps: venue = Soroswap (Soroban AMM)

- **Why not the native DEX:** a Vellar account is a contract (C…). A contract cannot
  source a classic `PathPaymentStrictSend`, and `/wallet/submit` only accepts
  `invokeHostFunction` transactions scoped to a known wallet. Native path payments
  are unreachable from the wallet without a second, classic account.
- **Venue:** Soroswap router (`lib/swap/soroswap.ts`; ids from
  `soroswap/core public/*.contracts.json`). Invoked like any contract, signed by the
  passkey through the existing `kit.sign` → `/wallet/submit` path. No new signing path.
- **Quote source:** `router_get_amounts_out`, simulated against live pair reserves —
  the venue itself. No oracle (§15.1). No fiat figure is shown.
- **Slippage model:** user tolerance 0.01%–5% (default 0.5%). `minOut = floor(expected ×
(1 − tolerance))`, encoded as the router's `amount_out_min`; the router reverts with
  `#507` below it. A zero floor is refused client-side (the router would accept 0).
  Quotes expire after 30 s; the build re-simulates and refuses to ask for a signature
  if the simulated output is already below the floor.
- **Approval** shows input, expected output, minimum received, quoted rate,
  worst-case rate, tolerance, route, router and network.
- **Partial fills:** a Soroban swap is atomic — it either executes at ≥ `minOut` or
  fails with no state change. There is no partial-fill state to surface; the UI reads
  the actual output from the transaction's return value and reports failure as
  "no tokens were exchanged".
- **Supported assets:** the registry below (XLM, USDC). Routes through any asset
  outside the registry are refused.
- **Testnet proof:** `lib/swap/soroswap.integration.test.ts`
  (`STELLAR_TESTNET_INTEGRATION=1`) quotes the live router, proves an above-market
  floor is refused (`#507`), and executes a real swap (G-account swapper; tx
  `1e565aa6fa5b6def0b73e8dde959e9d39c0fa3763b45e891a253d0c30d747881`, ledger 4855735).
  The passkey smart-wallet leg was not run live (needs WebAuthn + backend services).
- **Future work:** native DEX (would need a classic account), aggregator routing.

### Token registry (dependency of #407/#402)

`lib/assets.ts`: XLM + Circle USDC per network, SAC ids from vellar-sdk
`NetworkConfig` (tested to equal the SAC derived from code+issuer). Deliberately
minimal so #396 (full multi-asset plumbing) can extend or replace it.

## #402 — Receive + SEP-7

- Receive screen shows the smart-account C-address, one-tap copy, and a QR encoded
  on-device (`qrcode-generator`, no network). QR round-trips through an independent
  decoder (`jsqr`) in tests.
- **C-address compatibility:** SEP-7 v2.1.0 predates Soroban; `destination` is "an
  account ID or payment address" and assets are `asset_code`+`asset_issuer` only.
  Vellar emits `destination=C…`. Wallets that only build classic `Payment` ops cannot
  pay a C-address and will fail to build the request — they cannot misroute it. The
  receive screen says so. Scanning in external wallets has **not** been verified.
- **Incoming requests** (`/pay?uri=…`, registrable as the `web+stellar` handler) are
  parsed deny-by-default: unknown/duplicate params, malformed encoding, M… addresses,
  unregistered assets, wrong network, control/bidi characters, `callback`, and `tx`
  requests are rejected. **Memos are rejected**: the sponsor re-envelopes the
  transaction and cannot carry one, and paying an exchange request without its memo
  can lose funds. A claimed `origin_domain` is verified against its stellar.toml
  `URI_REQUEST_SIGNING_KEY` (key changes are flagged); otherwise the request is shown
  as from an unverified source. A valid request only prefills the existing send flow;
  review + passkey confirmation are still required.

## #406 — Verified-only agent spending

- **Decision:** default **never** — an agent key may not transact through unverified
  contracts. Opting a key out is possible only at mint time, with a stated reason
  (option 3 in the only form that is enforceable on-chain). Warn-and-allow was
  rejected: it cannot be enforced on-chain.
- **Enforcement:** the existing verified-recipient policy + attestation registry,
  as a **required co-signer in every grant** of the agent key's `SignerLimits`
  (`lib/agent-grants.ts` builds the grants for `wallet.agents.mint`, #394). It checks
  the contracts the agent's auth entries invoke, not the human/G-account receiving
  funds. On-chain enforcement of this shape was proven on testnet on 2026-08-01
  (private decisions log); no new testnet run was made for this PR.
- **Recovery / override:** get the contract verified (attestor upserts), pay it with
  the passkey (unrestricted admin signer), or re-issue the key without the gate
  (explicit reason, visible on-chain as the missing co-signer). No hidden bypass.
- **Honesty bar:** verified ≠ safe. Copy states provenance only; tested.

## #404 — CAP-0071-02 (type-2) credentials: current upstream state (verified 2026-09-25)

| Component                                            | State                                                                                                                                                 |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `x402-foundation/x402` facilitator (`@x402/stellar`) | V2 accepted — PR #3279 merged 2026-09-02, released in **2.25.0**                                                                                      |
| `OpenZeppelin/relayer-plugin-x402-facilitator`       | V2 accepted — PR #49 merged 2026-09-10, released **v0.5.0**                                                                                           |
| `coinbase/x402`                                      | Still V1-only (`scheme.ts:708`) but inactive since 2026-04-21; npm publishes from x402-foundation                                                     |
| `x402-foundation/x402#3158`                          | An **issue**, not a PR: the _client_ can't sign for a C-address. Open; fix PR #3018 unmerged. Vellar is unaffected (vellar-sdk ships its own signers) |
| Protocol 28 (activates V2 on-network)                | testnet 2026-08-27, mainnet vote 2026-09-16                                                                                                           |
| `Vellar-Wallet/vellar-facilitator`                   | **Pins `@x402/stellar` 2.20.0 — still rejects V2.** This is the remaining gate                                                                        |

No upstream PRs are needed. This repo has no passkey x402 payment path to flag
(the x402 client and signers live in vellar-sdk, whose passkey signer deliberately
emits V1). Enabling the passkey-kit V2 path requires: bump `vellar-facilitator` to
`@x402/stellar` ≥ 2.25.0, then a V2 option in vellar-sdk's passkey signer.
`technical-doc.md` §17.5 should read: facilitator-side blocker lifted upstream;
Vellar's hosted facilitator not yet upgraded.
