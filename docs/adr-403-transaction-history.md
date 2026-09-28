# ADR: Transaction history for the smart account (#403)

- **Issue:** #403 — Transaction history + dashboard account metadata/activity
- **Status:** Accepted, implemented (2026-09-28)
- **Scope:** `technical-doc.md` §5.2, §7.4; BUILD-PLAN Phase 2 (last open item);
  `docs/open-work-catalogue.md` Group 5 item 5.2

> **Where this lives.** The issue asks for this decision to be recorded in
> `docs/decisions.md`. That file is **gitignored** in this repository
> (`.gitignore:47`, under "IP / strategy docs — kept private for now"), so a
> record written there would not reach the repository or the reviewer. This ADR
> is the tracked equivalent and should be folded into `docs/decisions.md` when
> that file is next un-ignored.

## Context

The dashboard showed balances but no history, so a user could not answer "did my
payment go through?" without leaving for an external explorer. For a wallet
whose pitch is on-chain spending controls, the spend record is the evidence
those controls worked.

Three candidate data sources were on the table: Horizon, Soroban RPC
`getEvents`, and an events indexer in `worker-service` (which the notifications
backlog item is also waiting on). The issue explicitly asked that the choice be
made deliberately rather than by default.

## Decision

**Soroban RPC `getEvents` is the primary rail, read directly from the client.
Horizon's operations endpoint is a secondary rail, used only for classic
`G…` accounts. No `worker-service` indexer is introduced by this change.**

The `HistoryClient` interface in `apps/web/lib/history.ts` is the seam: if an
indexer is built later for notifications, only the implementation behind
`fetchPage` changes.

## Why, and what was verified

Every claim below was checked against `soroban-testnet.stellar.org` /
`horizon-testnet.stellar.org` on 2026-09-28, not inferred from documentation.

### 1. Horizon cannot supply SAC transfers — a Horizon-only build shows nothing

`GET /accounts/{C…}/operations` returns **400 Bad Request** for a contract
address. A smart account is a `C…` contract, which is exactly what this wallet
creates, so a Horizon-only history view would be empty for every real user.

For a classic `G…` account the same endpoint returns `invoke_host_function` rows
carrying no `from`, `to`, `amount` or `asset_type` — the token movement lives in
a contract event Horizon does not report.

Conclusion: Horizon alone misses essentially all of what this wallet does, which
is what the issue anticipated. Hence `getEvents` as the primary rail.

### 2. The classic rail must be gated on the address type

Because Horizon 400s on a `C…` address, the classic rail is only queried when
`accountId` starts with `G`. Querying it unconditionally is not a harmless extra
request — it fails the entire page for every smart wallet. There is a unit-level
guard in the live integration suite for exactly this.

### 3. Event shape, and why topic count must not be matched exactly

The live shapes:

| Contract | Topics | `value` |
| --- | --- | --- |
| Circle USDC SAC | `["transfer", from, to, "USDC:GBBD47…"]` | `i128` |
| Native XLM SAC | `["transfer", from, to, "native"]` | `i128` |
| Native XLM SAC (other events) | `["fee", to]`, `["approve", …]` | `i128` |

Matching `topic.length === 4` is brittle: it happens to work for both SACs
today, but SEP-41 also permits an implementation carrying the amount in a
`value` map behind a single topic, and an exact match would silently drop those
transfers. The parser therefore matches **topic[0] === "transfer" and
`topic.length >= 3`**, which accepts the real shapes and still excludes the
2-topic `fee` events.

`stellar-sdk` returns topics and values as **decoded** `xdr.ScVal` objects
(the raw JSON-RPC is base64), and returns `contractId` as a **StrKey object**,
not a string. Both are normalised explicitly.

### 4. Server-side topic filters are unreliable on the public RPC

Querying with a base64 XDR topic filter returned **0 events** on a window where
the unfiltered query returned 200 matching `transfer` events; the plain-string
form is rejected outright. The client therefore filters by contract id on the
server and discriminates by topic **client-side**. Passing a broken filter and
rendering the result would have looked exactly like "this wallet has no
history".

### 5. The ledger window must be clamped, not assumed

`startLedger` outside the node's retained range is rejected with
`startLedger must be within the ledger range: 4795309 - 4916268` (observed
verbatim), and the public RPC's retention varies behind its load balancer. The
first page is clamped to the window reported by `getHealth()`, and that error
string is in the retryable set alongside `txNoAccount` / `txBadSeq` /
`MissingValue`.

### 6. Paging and ordering

`getEvents` cursor paging was verified to advance (ids `…-0000000000..0005` then
`…-0000000006..0011`, no overlap). The `order` parameter is not part of the
SDK's `GetEventsRequest` and was observed being ignored, so it is not sent; the
**newest-first guarantee the UI relies on comes from `mergeHistoryPages`
sorting the merged stream**, not from the RPC. Both rails' positions ride in a
single opaque cursor so neither is re-scrolled from the top — the class of
defect `docs/security-audit.md` L6 was closed for.

### 7. Why not the `worker-service` indexer

It is the right long-term shape and the notifications item will likely need it,
but adopting it here would put dashboard history behind a deployment and a
backfill, and would add lag and schema questions to a view whose entire value is
being trustworthy immediately after a payment. Reading the chain directly gives
history that is correct by construction. The interface seam means migrating
later is a contained change.

## Consequences

- History is correct immediately after a transaction, with no indexer lag.
- Cost scales with the lookback window, bounded by node retention.
- Asset metadata for the two assets this wallet holds is resolved from the
  pinned per-network config (no network round-trip); other contracts are asked
  via read-only simulation, and a row whose asset cannot be resolved is **dropped
  rather than rendered as a bare number**.
- `getEvents` returns a filtered stream, not an account ledger: it shows token
  transfers, not every contract invocation. That matches what the dashboard
  needs, and is stated in the UI's empty state.
