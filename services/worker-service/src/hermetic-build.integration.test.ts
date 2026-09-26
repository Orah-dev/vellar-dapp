import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  BuildExecutorError,
  defaultRun,
  dockerBuildExecutor,
  type DockerBuildExecutorConfig,
} from "./executor";
import { assertPublicHttpsRepoUrl } from "./repo-url-guard";

// #420 — the real isolation boundary, not a mock of it. Each case runs the
// production dockerBuildExecutor end to end: the real repo-url-guard, the real
// Cargo.lock pre-fetch against crates.io / GitHub, and a real `docker run
// --network=none` in the toolchain image. The one substitution is the
// top-level clone: the fixture is a local git repo instead of a public URL.
//
// Needs Docker, the toolchain image and internet access for the pre-fetch, so
// it only runs when VERIFY_BUILD_IMAGE names a built image:
//   docker build -f infra/docker/verification-builder.Dockerfile \
//     -t vela-verify:1.94.0 infra/docker
//   VERIFY_BUILD_IMAGE=vela-verify:1.94.0 pnpm --filter @vellar/worker-service \
//     exec vitest run src/hermetic-build.integration.test.ts
// The Soroban case compiles ~190 crates (several minutes).

const IMAGE = process.env.VERIFY_BUILD_IMAGE;
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FIXTURES = join(REPO_ROOT, "services/worker-service/test-fixtures/hermetic");
const FIXTURE_URL = "https://fixture.invalid/submitted-repo";

const cleanup: string[] = [];
afterAll(async () => {
  await Promise.all(cleanup.map((d) => rm(d, { recursive: true, force: true })));
});

/** Copies a fixture into a fresh git repo (the "submitted repository"). */
async function submittedRepo(source: string): Promise<{ path: string; commit: string }> {
  const path = await mkdtemp(join(tmpdir(), "vellar-hermetic-"));
  cleanup.push(path);
  await cp(source, path, {
    recursive: true,
    filter: (src) => !src.split(/[\\/]/).includes("target"),
  });
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@invalid", ...args], {
      cwd: path,
      encoding: "utf8",
    }).trim();
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "fixture");
  return { path, commit: git("rev-parse", "HEAD") };
}

function executorFor(repo: { path: string }, extra: Partial<DockerBuildExecutorConfig> = {}) {
  const dockerRuns: string[][] = [];
  const executor = dockerBuildExecutor({
    image: IMAGE!,
    timeoutSeconds: 1800,
    memory: "4g",
    ...extra,
    // Every URL except the fixture's own goes through the real SSRF guard.
    assertRepoUrl: async (url) => (url === FIXTURE_URL ? undefined : assertPublicHttpsRepoUrl(url)),
    run: (cmd, args, cwd, timeoutMs, env) => {
      if (cmd === "docker" && args[0] === "run") dockerRuns.push(args);
      if (cmd === "git" && args.includes("clone") && args.includes(FIXTURE_URL)) {
        return defaultRun(
          "git",
          ["clone", "--no-checkout", "--", repo.path, "repo"],
          cwd,
          timeoutMs,
          env,
        );
      }
      return defaultRun(cmd, args, cwd, timeoutMs, env);
    },
  });
  return { executor, dockerRuns };
}

const buildInput = (commit: string) => ({
  sourceType: "repo" as const,
  repoUrl: FIXTURE_URL,
  commitHash: commit,
  toolchainVersion: "1.94.0",
});

describe.skipIf(!IMAGE)("hermetic offline build (real Docker, #420)", () => {
  it("submitted code cannot reach the network during the build", async () => {
    const repo = await submittedRepo(join(FIXTURES, "net-probe"));
    const { executor, dockerRuns } = executorFor(repo);

    const err = await executor.build(buildInput(repo.commit)).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(BuildExecutorError);
    const log = (err as BuildExecutorError).log;
    expect(log).toContain("VELLAR_NET_PROBE=BLOCKED");
    expect(log).not.toContain("VELLAR_NET_PROBE=CONNECTED");
    expect(dockerRuns).toHaveLength(1);
    expect(dockerRuns[0]).toContain("--network=none");
  }, 300_000);

  it("control: the same probe DOES connect when a container has network", async () => {
    // Proves the probe can detect connectivity, so BLOCKED above is the
    // sandbox and not a broken probe. Test-only: production never runs this.
    const repo = await submittedRepo(join(FIXTURES, "net-probe"));
    let out = "";
    try {
      execFileSync(
        "docker",
        ["run", "--rm", "-v", `${repo.path}:/work`, "-w", "/work", IMAGE!, "cargo", "build"],
        {
          encoding: "utf8",
          stdio: "pipe",
        },
      );
    } catch (e) {
      out = String((e as { stderr?: string }).stderr ?? "");
    }
    expect(out).toContain("VELLAR_NET_PROBE=CONNECTED");
  }, 300_000);

  it("a dependency-free contract builds offline", async () => {
    const repo = await submittedRepo(join(FIXTURES, "no-deps"));
    const { executor, dockerRuns } = executorFor(repo);
    const result = await executor.build(buildInput(repo.commit));
    expect(result.wasm.byteLength).toBeGreaterThan(0);
    expect(result.wasmHash).toMatch(/^[0-9a-f]{64}$/);
    expect(dockerRuns).toHaveLength(1);
    expect(dockerRuns[0]).toContain("--network=none");
  }, 300_000);

  it("an unresolvable dependency fails clearly and never starts a build", async () => {
    const repo = await submittedRepo(join(FIXTURES, "unresolvable"));
    const { executor, dockerRuns } = executorFor(repo);
    await expect(executor.build(buildInput(repo.commit))).rejects.toMatchObject({
      name: "BuildExecutorError",
      code: "dependencies_unresolved",
    });
    expect(dockerRuns).toHaveLength(0);
  }, 300_000);

  it("a real Soroban workspace (crates.io + git deps) reproduces its deployed hash offline", async () => {
    const templates = await readFile(
      join(REPO_ROOT, "services/policy-service/src/templates.ts"),
      "utf8",
    );
    const deployed = templates.match(/SPENDING_POLICY_WASM_HASH =\s*"([0-9a-f]{64})"/)?.[1];
    expect(deployed).toBeDefined();

    const repo = await submittedRepo(join(REPO_ROOT, "contracts"));
    const { executor, dockerRuns } = executorFor(repo, {
      buildArgs: ["--package", "vela-spending-limit-policy"],
      expectedWasmPath: "target/wasm32v1-none/release/vela_spending_limit_policy.wasm",
      cpus: "4",
    });
    const result = await executor.build(buildInput(repo.commit));

    expect(result.log).toMatch(/\[prefetch\] \d+ crates\.io package\(s\), 1 git dependency/);
    expect(dockerRuns).toHaveLength(1);
    expect(dockerRuns[0]).toContain("--network=none");
    expect(result.wasmHash).toBe(deployed);
  }, 1_800_000);
});
