"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import type { Network } from "@vellar/types";
import type { HistoryTx } from "./history-types";
import { createHistoryClient, type HistoryClient } from "./history";
import { walletConfig } from "./config";

// Dashboard activity data hook (issue #403). Mirrors balances.ts: the SDK loads
// lazily, the client is module-scoped, and react-query owns
// loading/error/refetch state.
//
// The hook deliberately does NOT block dashboard render: consumers render their
// panel shell immediately and swap in content as the query resolves.
//
// A single useInfiniteQuery owns every page. An earlier draft modelled this as
// "first page" + "next page" queries that a component merged via setState
// during render, which is both a React anti-pattern and the reason the panel
// needed local accumulator state. useInfiniteQuery keeps the page list in one
// place, so "load older" is a fetchNextPage() and dedup happens once, here.

export const HISTORY_PAGE_SIZE = 20;

let client: HistoryClient | undefined;

function historyClient(): HistoryClient {
  client ??= createHistoryClient({
    rpcUrl: walletConfig().rpcUrl,
    horizonUrl: walletConfig().horizonUrl,
    networkPassphrase: walletConfig().networkPassphrase,
  });
  return client;
}

/**
 * Flattens the fetched pages into one newest-first list, de-duplicated by row
 * id. The two rails can return the same underlying event on adjacent pages
 * when a cursor boundary lands mid-stream, and a repeated key would make React
 * drop a row.
 */
function flattenPages(pages: Array<{ rows: HistoryTx[] }>): HistoryTx[] {
  const seen = new Set<string>();
  const rows: HistoryTx[] = [];
  for (const page of pages) {
    for (const row of page.rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(row);
    }
  }
  return rows;
}

/**
 * Activity for the account, newest first, paginated via `fetchNextPage`.
 *
 * A surfaced error is a real one: transient RPC failures are retried inside the
 * client, so what reaches this hook has already exhausted its retries. The
 * consumer must show a "history unavailable — retry" state rather than an empty
 * list, per the issue's hard requirement.
 */
export function useActivity(accountId: string | undefined, network: Network | undefined) {
  const query = useInfiniteQuery({
    queryKey: ["activity", accountId, network],
    enabled: accountId !== undefined && network !== undefined,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      historyClient().fetchPage({
        accountId: accountId as string,
        network: network as Network,
        cursor: pageParam,
        pageSize: HISTORY_PAGE_SIZE,
      }),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: 30_000,
  });

  const rows = query.data ? flattenPages(query.data.pages) : [];

  return {
    ...query,
    rows,
    hasMore: query.hasNextPage,
    isLoadingMore: query.isFetchingNextPage,
    loadMore: () => query.fetchNextPage(),
  };
}
