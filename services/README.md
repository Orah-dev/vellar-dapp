# Services

Backend services, all reached through `api-gateway`, the single public entry
point (see `api-gateway/src/server.ts`'s own top-of-file comment for the
cross-cutting controls that live there rather than per-service).

- `api-gateway/`: reverse proxy, versioning, CORS, rate limiting, security
  headers, and the verification-service circuit breaker.
- `wallet-service/`: passkey wallet creation/connect/submit and session
  management.
- `lifecycle-service/`: wallet lifecycle operations.
- `policy-service/`: spending-policy generation and deployment.
- `verification-service/`: contract verification submission and status.
- `permission-service/`, `worker-service/`, `all-in-one/`: see each
  service's own source for scope.

## API versioning (issue #258)

Every route `api-gateway` proxies is registered under **both** a `/v1`-prefixed
path and the original unversioned path, via `registerVersionedProxyRoute` in
`api-gateway/src/register-proxy-route.ts`. Both forward to the same backend
path; nothing downstream needs to change or know which prefix a caller used.

- **New clients (extension, web app) should call the `/v1` paths.** `/v1/wallet/...`,
  `/v1/lifecycle/...`, `/v1/policies/...`, `/v1/verification/...`.
- **The unversioned paths remain live during a migration window** so existing
  deployed clients are not broken by this change landing. They are not a
  second surface to design around going forward: new routes should default to
  being added under `/v1` only, and any accumulated unversioned-only route
  should be flagged for a version-alias addition, not treated as permanently
  unversioned.
- **When a `/v2` (or later) becomes necessary**, it is not a drop-in
  replacement of `/v1` at the gateway: whichever behavior actually changed
  between versions has to be dispatched per-version, not just proxied under a
  new prefix to the same unversioned backend route. That is a real design
  decision for whoever adds the next version, not something this policy can
  pre-decide.
- **Removing the unversioned aliases** is a breaking change for any client
  still calling them and should be scheduled as its own deliberate,
  communicated change, not bundled silently into an unrelated PR.
