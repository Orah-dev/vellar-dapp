# Phase 7 hardening — progress

Tracks #419, #417, #418, #416 on `feat/phase-7-hardening`.

- [x] Shared-DB migration runner fix (hash-based, not drizzle's timestamp rule) — `packages/service-kit/src/migrations.ts`
- [x] #419 verification hardening: metadata-tolerant wasm comparison — `services/worker-service/src/wasm-compare.ts` + tests, wired into `verify.ts`
  - real cross-toolchain fixture pair (rustc 1.93.0 vs 1.94.0), `cliver` dropped after empirical build showed stellar-cli does not stamp it (see `docs/decisions.md`)
- [x] #416 replay protection: replay key extraction + in-memory guard — `services/wallet-service/src/replay.ts`
- [ ] #416 Postgres-backed replay guard + concurrency test against real Postgres — `services/wallet-service/src/db/pg-replay.ts` (needs verification run)
- [ ] #416 wiring into `services/wallet-service/src/server.ts` submit path — needs review
- [ ] #418 staging environment policy — `packages/service-kit/src/environment.ts` written, NOT yet exported from service-kit or wired into any service boot / render.yaml
- [ ] #418 render.yaml staging tier + secret isolation
- [ ] #418 config.staging.test.ts-pattern tests for the new environment module
- [ ] #417 browser compatibility matrix — not started
- [ ] Cross-issue integration pass
- [ ] docs/decisions.md entries for every deviation
- [ ] Full validation pass (typecheck, lint, build, full test suite)
