# Hermetic verification builds (#420)

Decision record for BUILD-PLAN Phase 7 "hermetic `--network=none` dep vendoring /
lockfile pre-fetch". `docs/decisions.md` is not tracked in this repository, so the
entry lives here; copy it across if you keep the private log.

## Decision (2026-09-25)

The worker builds arbitrary submitted repositories, so their content is hostile
input (H2/H3). The build container already ran with `--network=none`, but nothing
put dependencies on disk first, so any repository with a crates.io or git
dependency could not build at all.

Dependencies are now resolved **on the host, from `Cargo.lock` only, before the
build**, and handed to the `--network=none` build read-only:

```text
submitted repoUrl ──▶ repo-url-guard (public https, DNS answers checked, IP pinned)
      │
      ▼
git clone (host, pinned IP, no redirects, https only) ──▶ checkout commit
      │
      ▼
Cargo.lock parsed as data (cargo-prefetch.ts) — no submitted code runs
      ├─ crates.io package ─▶ index.crates.io + static.crates.io (fixed hosts,
      │                        guard-validated + pinned, sha256 == lockfile)
      ├─ git dependency ────▶ same guard/pin/no-redirect/https-only as the clone
      └─ anything else ─────▶ refused (dependencies_unresolved)
      │
      ▼
deps/registry  (cargo local-registry)      deps/git/<id>  (bare mirrors)
      │
      ▼
docker run --network=none --read-only --cap-drop=ALL --user 1000:1000
  -v deps:/deps:ro  -e CARGO_HOME=/cargo-home  -e GIT_CONFIG_GLOBAL=/deps/gitconfig
  stellar contract build --locked
      │
      ▼
wasm hash ──▶ compare with on-chain hash ──▶ private log + sanitized statusDetail
```

- cargo sees crates.io replaced by the local registry (`CARGO_HOME/config.toml`),
  and every locked git URL rewritten to its mirror by `url.insteadOf` in a git
  config that lives on the read-only `/deps` mount.
- `--locked` makes the build use exactly what the lockfile — and so the
  pre-fetch — pinned.
- **No fallback.** A pre-fetch failure fails the job before any container
  starts. The build has one invocation, `--network=none` is hard-coded, and no
  config or environment variable turns networking back on.

### Why the host, and not `cargo fetch` in a networked container

`cargo fetch` in a container with network would be simpler, but every destination
would then come from submitter-controlled manifests with only cargo between them
and the network, and a repository's `.cargo/config.toml` (rustc wrappers,
credential providers) can make cargo run commands. Doing the fetch in the worker
means the only network code is ours, and every host goes through the H2 guard.

### Reproducibility

Swapping the crates.io source for a local registry changes where cargo unpacks
crates. The repository's own `vela-spending-limit-policy` contract (193 crates.io
packages + the passkey-kit git dependency) rebuilt hermetically to
`c42ab9b5…fcbdf`, exactly `SPENDING_POLICY_WASM_HASH`, the hash deployed from the
canonical networked build. That case is part of
`hermetic-build.integration.test.ts`.

### What submitters need

A committed, up-to-date `Cargo.lock` at the repository root; dependencies only
from crates.io or public https git (pinned to a commit, no submodules). Anything
else fails with `dependencies_unresolved` and a public hint saying so.

## Network boundary

| Question                                        | Answer                                                                                                                                                                                                                                                                     |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Which stage has network access?                 | Only the worker process on the host: the repo clone and the dependency pre-fetch. No container has network.                                                                                                                                                                |
| Why is that stage safe?                         | It runs no submitted code. `Cargo.lock` is parsed as data by a strict parser; names/versions must be path-safe; crates are checked against the lockfile sha256.                                                                                                            |
| What inputs choose destinations?                | crates.io hosts are constants; the lockfile only picks crate names/versions. Git dependency URLs are submitter-chosen.                                                                                                                                                     |
| What validation applies?                        | Every host (fixed or not) goes through `assertPublicHttpsRepoUrl`: https only, no userinfo, every DNS answer checked by `isBlockedAddress`, connection pinned to the validated IP, redirects not followed. Other registries, ssh/http/file git and submodules are refused. |
| When does the network become unavailable?       | At `docker run --network=none`. The container has only loopback.                                                                                                                                                                                                           |
| Can submitted code run before that boundary?    | No. Nothing from the repository executes on the host; `build.rs` and proc macros first run inside the container.                                                                                                                                                           |
| Can build scripts escape the network namespace? | Every process in the container shares its namespace. `--cap-drop=ALL` + `no-new-privileges` + non-root prevent creating a routed namespace, and the Docker socket is not mounted.                                                                                          |
| Can cargo reach the network during the build?   | No route exists. cargo's crates.io source is the read-only local registry and git is rewritten to file mirrors with `protocol.allow=never` except `file`. The real-Docker test proves a `build.rs` DNS lookup and TCP connect both fail.                                   |
| Can dependency resolution silently retry?       | Pre-fetch failures are classified: `dependencies_unresolved` is permanent; `dependency_fetch_failed` is retried by the queue — the retry repeats the guarded pre-fetch and the same offline build, never a networked one.                                                  |
| Is there an env var that re-enables networking? | No. `--network=none` is a literal argument, not configuration.                                                                                                                                                                                                             |
| Does the sandbox survive process failures?      | A timeout kills the Docker CLI, which does not stop the container, so the container is named and removed (`docker rm -f`). Every temporary directory is removed in `finally`.                                                                                              |

### RA-7

Unchanged and not widened. Git dependency URLs use the same guard as the clone,
and a bracketed IPv6 literal (e.g. `https://[::ffff:7f00:1]/…`) is refused by the
pre-fetch URL check before the guard runs, so the hex-form gap in
`isBlockedAddress` is not reachable from a lockfile either (tested).

## Tests

- `cargo-prefetch.test.ts` — lockfile parsing, source policy, checksum/404/5xx
  classification, pin and redirect behaviour, H2 regressions for git dependencies.
- `executor.test.ts` — offline mounts, `--locked`, deps outside the checkout,
  no container after a pre-fetch failure, no retry after a build failure,
  container removal on timeout.
- `verify.test.ts` — actionable but sanitized `statusDetail` (H3).
- `hermetic-build.integration.test.ts` — real Docker: outbound probe blocked (with
  a networked control proving the probe works), dependency-free build, unresolvable
  dependency never starts a container, Soroban workspace reproduces its deployed
  hash. Runs in CI via `.github/workflows/hermetic-build.yml`; locally with
  `VERIFY_BUILD_IMAGE=vela-verify:1.94.0`.
