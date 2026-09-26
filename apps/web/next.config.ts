import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Workspace packages ship raw TypeScript (exports point at src/), so Next
  // must transpile them. passkey-kit and its SDK deps also ship raw TS.
  transpilePackages: [
    "passkey-kit",
    "passkey-kit-sdk",
    "sac-sdk",
    "@vellar/types",
    "@vellar/ui",
    "vellar-sdk",
    "@vellar/passkey",
    "@vellar/provider-sdk",
    "@vellar/verification-sdk",
  ],
  // Next 16.3+ `next dev` writes AGENTS.md/CLAUDE.md into the app dir by default.
  agentRules: false,
};

export default nextConfig;
