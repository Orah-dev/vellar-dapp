import type { Network } from "@vellar/types";
import type { HistoryAsset, HistoryPage } from "./history-types";
import {
  contractIdOf,
  decodePageCursor,
  encodePageCursor,
  mergeHistoryPages,
  withTransientRetry,
  type ClassicOp,
  type RawEvent,
  type ScValDecoder,
} from "./history-parse";

// Transaction history client for the smart account (issue #403;
// technical-doc.md §5.2/§7.4).
//
// Data source: Soroban RPC getEvents as the PRIMARY rail, Horizon's operations
// endpoint as a SECONDARY rail for classic G-accounts. The full rationale,
// including the two behaviours verified live against testnet, is in
// docs/adr-403-transaction-history.md. In short:
//
//  * Soroban/SAC transfers are contract EVENTS. Horizon does not serve them.
//    Verified: GET /accounts/{C…}/operations answers 400 Bad Request, so a
//    Horizon-only implementation shows nothing at all for the smart accounts
//    this wallet actually creates.
//  * The classic rail is therefore gated on the address actually being classic
//    (a G…). Querying a C-address unconditionally is not a harmless extra
//    request — it is a hard 400 that fails the whole page.
//
// Pure helpers (parsing/retry/cursors) live in history-parse.ts so unit tests
// run without the SDK; this module wires the real client, and component tests
// mock HistoryClient the way they mock balances.ts.

const DEFAULT_PAGE_SIZE = 20;
/** First-page getEvents lookback (~2 days of ledgers at ~5s). */
const LOOKBACK_LEDGERS = 34_560;
const ASSET_CACHE_LIMIT = 512;
const SIMULATION_SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

export interface HistoryClient {
  fetchPage(args: {
    accountId: string;
    network: Network;
    cursor?: string;
    pageSize?: number;
  }): Promise<HistoryPage>;
}

type StellarSdk = typeof import("@stellar/stellar-sdk");

/** A classic account id starts with G; a smart account is a C… contract. */
function isClassicAccount(accountId: string): boolean {
  return accountId.startsWith("G");
}

export function createHistoryClient(config: {
  rpcUrl: string;
  horizonUrl: string;
  networkPassphrase: string;
}): HistoryClient {
  // The SDK is heavy and off the onboarding path — lazy-load like balances.ts.
  let sdkPromise: Promise<StellarSdk> | undefined;
  const loadSdk = () => (sdkPromise ??= import("@stellar/stellar-sdk"));

  const assetCache = new Map<string, Promise<HistoryAsset | undefined>>();

  /**
   * Assets this wallet can already name without a network round-trip. Both
   * SACs are pinned per network in vellar-sdk, so the common case costs zero
   * simulations and the issuer-pinned USDC id can never be swapped for an
   * impostor asset that also calls itself "USDC".
   */
  async function knownAsset(
    lib: StellarSdk,
    contractId: string,
  ): Promise<HistoryAsset | undefined> {
    const { TESTNET } = await import("vellar-sdk");
    const candidates: Array<{ contractId: string; code: string; decimals: number }> = [
      { contractId: TESTNET.nativeTokenContractId, code: "XLM", decimals: 7 },
      { contractId: TESTNET.usdcContractId, code: "USDC", decimals: 7 },
    ];
    const hit = candidates.find((c) => c.contractId === contractId);
    if (!hit) return undefined;
    return { kind: "soroban", code: hit.code, decimals: hit.decimals, contractId };
  }

  function resolveAsset(
    lib: StellarSdk,
    rpcServer: InstanceType<StellarSdk["rpc"]["Server"]>,
    contractId: string,
  ): Promise<HistoryAsset | undefined> {
    const cached = assetCache.get(contractId);
    if (cached) return cached;
    const pending = resolveAssetUncached(lib, rpcServer, contractId).catch(() => undefined);
    if (assetCache.size < ASSET_CACHE_LIMIT) assetCache.set(contractId, pending);
    return pending;
  }

  async function resolveAssetUncached(
    lib: StellarSdk,
    rpcServer: InstanceType<StellarSdk["rpc"]["Server"]>,
    contractId: string,
  ): Promise<HistoryAsset | undefined> {
    const known = await knownAsset(lib, contractId);
    if (known) return known;

    // Unknown contract: ask it for symbol()/decimals() via read-only simulation
    // on a synthetic source account — the same trick balances.ts uses for
    // balance reads. Verified working against the live USDC SAC.
    const call = async (fn: "symbol" | "decimals"): Promise<unknown> => {
      const tx = new lib.TransactionBuilder(new lib.Account(SIMULATION_SOURCE, "0"), {
        fee: "100",
        networkPassphrase: config.networkPassphrase,
      })
        .addOperation(
          lib.Operation.invokeContractFunction({ contract: contractId, function: fn, args: [] }),
        )
        .setTimeout(60)
        .build();
      const sim = await withTransientRetry(() => rpcServer.simulateTransaction(tx));
      if (!lib.rpc.Api.isSimulationSuccess(sim) || !sim.result) return undefined;
      return lib.scValToNative(sim.result.retval);
    };
    const [symbol, decimals] = await Promise.all([call("symbol"), call("decimals")]);
    if (typeof symbol !== "string" || typeof decimals !== "number" || decimals < 0) {
      return undefined;
    }
    return { kind: "soroban", code: symbol, decimals, contractId };
  }

  return {
    async fetchPage({ accountId, network, cursor, pageSize = DEFAULT_PAGE_SIZE }) {
      void network; // endpoints are already network-scoped via config
      const lib = await loadSdk();
      const decoder: ScValDecoder = (scVal) => lib.scValToNative(scVal as never);
      const pack = decodePageCursor(cursor);
      const rpcServer = new lib.rpc.Server(config.rpcUrl, {
        allowHttp: config.rpcUrl.startsWith("http://"),
      });

      // --- Rail 1: SAC transfer events (getEvents, cursor-paginated) --------
      // No `order` is requested: it is not part of the SDK's GetEventsRequest
      // and the public node was observed ignoring it. Paging is driven purely
      // by the returned cursor (verified: successive pages are disjoint), and
      // the newest-first guarantee the UI depends on comes from
      // mergeHistoryPages sorting the merged stream, not from the RPC.
      let eventPage: { events: RawEvent[]; cursor?: string };
      const eventsCursor = pack?.events;
      if (eventsCursor) {
        const res = await withTransientRetry(() =>
          rpcServer.getEvents({
            cursor: eventsCursor,
            limit: pageSize,
            filters: [],
          }),
        );
        eventPage = res as unknown as { events: RawEvent[]; cursor?: string };
      } else {
        // First page: bounded lookback window ending at the latest ledger,
        // CLAMPED to the window the node actually retains. The public RPC's
        // retention varies by which node its load balancer picks, and asking
        // for a start ledger below oldestLedger is rejected outright with
        // "startLedger must be within the ledger range" — the stale-view
        // failure mode this view is required to survive.
        const health = await withTransientRetry(() => rpcServer.getHealth());
        const latest = health.latestLedger;
        const oldest = Math.min(health.oldestLedger ?? 1, latest);
        const startLedger = Math.max(oldest, latest - LOOKBACK_LEDGERS);
        const res = await withTransientRetry(() =>
          rpcServer.getEvents({
            startLedger,
            limit: pageSize,
            filters: [],
          }),
        );
        eventPage = res as unknown as { events: RawEvent[]; cursor?: string };
      }

      // --- Rail 2: classic operations (Horizon, cursor-paginated) -----------
      // Classic accounts only. Horizon answers 400 for a C-address, and an
      // unconditional call here would fail the entire page for every smart
      // wallet — the one account type this feature is for.
      let classicOps: ClassicOp[] = [];
      let opsExhausted = true;
      if (isClassicAccount(accountId)) {
        const horizonServer = new lib.Horizon.Server(config.horizonUrl, {
          allowHttp: config.horizonUrl.startsWith("http://"),
        });
        const opsBuilder = horizonServer
          .operations()
          .forAccount(accountId)
          .limit(pageSize)
          .order("desc");
        const opsPage = await withTransientRetry(() =>
          (pack?.ops ? opsBuilder.cursor(pack.ops) : opsBuilder).call(),
        );
        classicOps = opsPage.records as unknown as ClassicOp[];
        opsExhausted = classicOps.length < pageSize;
      }

      // Resolve every SAC contract id on this page BEFORE merging so rows
      // never render an amount without its asset (issue #403 hard rule).
      const contractIds = new Set(
        eventPage.events.filter((e) => e.type === "contract").map(contractIdOf),
      );
      const resolved = new Map<string, HistoryAsset | undefined>();
      await Promise.all(
        [...contractIds].map(async (contractId) => {
          resolved.set(contractId, await resolveAsset(lib, rpcServer, contractId));
        }),
      );

      const { rows } = mergeHistoryPages({
        accountId,
        events: eventPage.events,
        ops: classicOps,
        assetOf: (contractId) => resolved.get(contractId),
        pageSize,
        decoder,
      });

      const lastOpToken = classicOps[classicOps.length - 1]?.paging_token;
      const eventsExhausted = eventPage.cursor === undefined;
      // Continue while EITHER rail has more; the packed cursor carries both
      // positions so the next page resumes exactly here (security-audit L6:
      // no rail may be re-scrolled from the top).
      const nextCursor =
        eventsExhausted && opsExhausted ? undefined : encodePageCursor(eventPage.cursor, lastOpToken);

      return { rows, nextCursor };
    },
  };
}
