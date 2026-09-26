# Transaction Submission Load Testing

This document details the load testing suite for transaction submission under burst traffic conditions (Issue #318).

## Overview

The transaction submission load test harness (`contrib/load-test-submission.ts`) evaluates system behavior under increasing levels of concurrency (e.g. 1, 5, 10, 25, 50 concurrent submitters).

It measures key performance indicators:

- **Throughput**: Requests Per Second (RPS)
- **Latency Percentiles**: p50, p95, and p99 latency in milliseconds
- **Error Rates**: Percentage of failed submissions due to RPC rate limits or network congestion
- **Bottleneck Detection**: Pinpoints concurrency levels where error rates exceed maximum allowed SLA thresholds (default: 5%).

## Running the Load Test

Run the load test locally or in test environments using pnpm:

```bash
pnpm test:load
```

Or execute directly via `tsx`:

```bash
npx tsx contrib/load-test-submission.ts
```

## Continuous Integration (CI)

Not currently run in CI. The harness (`contrib/load-test-submission.ts`) and the root `test:load` script were removed in `44d8ce1`, so the CI step that called it was removed too (see `docs/ci-baseline.md`). Restore the harness before re-adding the step.

## Observed Limits & Bottlenecks

- **Concurrency Threshold 1 - 10**: Low latency (p50 ~ 25ms, p95 ~ 65ms) with < 1% error rate under standard testnet RPC conditions.
- **Concurrency Threshold 10 - 25**: Moderate queueing; latency rises to p95 ~ 140ms with error rate remaining under 3%.
- **Concurrency Threshold 25+**: Bottlenecks emerge as Stellar RPC rate limits and worker submission concurrency saturate. Error rates exceed 5% SLA threshold if exponential backoff / circuit breaker is not engaged.
