import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { build, loadConfig, localProject, selectsGitHub } from "../src/compose.js";
import { readStoredProject } from "../src/core/project-labels.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { NoOpSandbox } from "../src/impl/sandbox/noop-sandbox.js";
import { runProcess } from "../src/impl/process/run-process.js";
import { REGISTRY, type Registry, withPlugin } from "../src/plugins.js";
import type { Selection } from "../src/plugin-api.js";
import type { ToolBroker } from "../src/interfaces/tool-broker.js";
import { fakeGitHubAccess } from "./helpers/fakes.js";

// Startup with no GitHub plugin selected (design 05-sources, Local startup): no GitHub credential is read, no
// repository lookup is made, the broker is the local one, and nothing fetches origin.

const REAL = JSON.parse(readFileSync(join(import.meta.dirname, "..", "factory.config.json"), "utf8")) as Record<string, unknown>;

afterEach(() => vi.unstubAllEnvs());

/** The solo default: the local source, local auth, the local broker, static grants only. */
const SOLO = {
  auth: "local",
  permissions: { grants: ["static"] },
  plugins: { ...(REAL.plugins as object), awake: "none", updater: "none", source: ["local"], broker: "local", github_auth: "recording" },
};

function root(overrides: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "sf-local-start-"));
  mkdirSync(join(dir, "prompts"));
  for (const p of ["triage", "implement", "review", "resolve"]) writeFileSync(join(dir, "prompts", `${p}.md`), p);
  writeFileSync(join(dir, "factory.config.json"), JSON.stringify({ ...REAL, store: { type: "sqlite" }, state_dir: "state", worktrees_dir: "wt", ...overrides }));
  writeFileSync(join(dir, "secrets.env"), "MYSQL_PASSWORD=pw\n");
  vi.stubEnv("SOFTWARE_FACTORY_SECRETS_FILE", join(dir, "secrets.env"));
  return dir;
}

/** A registry that counts GitHub credential reads and which broker plugins were built. */
function recordingRegistry() {
  const seen = { credentials: 0, tokens: 0, githubBroker: 0, localBroker: 0 };
  let registry: Registry = withPlugin(REGISTRY, "github_auth", "recording", () => {
    seen.credentials++;
    return fakeGitHubAccess({ token: async () => (seen.tokens++, null) });
  });
  registry = withPlugin(registry, "broker", "github", () => {
    seen.githubBroker++;
    return {} as ToolBroker;
  });
  registry = withPlugin(registry, "broker", "local", (c) => {
    seen.localBroker++;
    return REGISTRY.broker.plugins.local!(c);
  });
  return { registry, seen };
}

describe("the one rule: is a GitHub plugin selected", () => {
  const sel = (over: Partial<Selection>): Selection => ({ ...({ source: "local", auth: "local", broker: "local" } as Selection), ...over });

  it("no GitHub source, auth, broker, forge or grant: the local path", () => {
    expect(selectsGitHub(sel({}), ["static"])).toBe(false);
  });

  it("any one GitHub plugin or grant selects GitHub", () => {
    expect(selectsGitHub(sel({ sources: ["local", "github-issues"] }), ["static"])).toBe(true);
    expect(selectsGitHub(sel({ source: "github-issues" }), ["static"])).toBe(true);
    expect(selectsGitHub(sel({ auth: "github" }), ["static"])).toBe(true);
    expect(selectsGitHub(sel({ local_auth: "github" }), ["static"])).toBe(true);
    expect(selectsGitHub(sel({ broker: "github" }), ["static"])).toBe(true);
    expect(selectsGitHub(sel({ forge: "github" }), ["static"])).toBe(true);
    expect(selectsGitHub(sel({}), ["static", "github-permission"])).toBe(true);
  });

  it("loadConfig marks the solo config local_only, and leaves a GitHub config as it was", async () => {
    const { registry } = recordingRegistry();
    expect((await loadConfig(root(SOLO), { registry })).config.local_only).toBe(true);
    expect((await loadConfig(root({ plugins: { ...(REAL.plugins as object), awake: "none" } }))).config).not.toHaveProperty("local_only");
  });
});

describe("build() with no GitHub plugin selected", () => {
  it("reads no GitHub credential, makes no repository lookup, builds the local broker and stores the local project key", async () => {
    const { registry, seen } = recordingRegistry();
    const loaded = await loadConfig(root(SOLO), { registry });
    const lookups: string[] = [];
    const repoLookup = { repoIdentity: async (r: { owner: string; name: string }) => (lookups.push(`${r.owner}/${r.name}`), Promise.reject(new Error("no"))) };
    const built = await build(loaded, { clock: new FakeClock(), repoLookup });
    try {
      const { owner, name } = loaded.config.repo;
      expect(lookups).toEqual([]);
      expect(seen).toEqual({ credentials: 0, tokens: 0, githubBroker: 0, localBroker: 1 });
      expect(built.project).toEqual(localProject({ owner, name }));
      expect(built.project.key).toMatch(/^local:local:[0-9a-f]{32}$/);
      expect(built.project.label).toBe(`local/${owner}/${name}`);
      // #350's stored key: what the CLI's `task create` and the next start read.
      expect(await readStoredProject(built.store, { owner, name })).toEqual(built.project);
      await built.controller.tickIntake();
    } finally {
      await built.close();
    }
    // A second start finds the same key, still with no GitHub call.
    const again = await build(loaded, { clock: new FakeClock(), repoLookup });
    expect(again.project.key).toBe(localProject(loaded.config.repo).key);
    await again.close();
    expect(lookups).toEqual([]);
    expect(seen.credentials).toBe(0);
  });
});

describe("NoOpSandbox with no GitHub plugin selected (local)", { timeout: 30_000 }, () => {
  const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" };
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV }).trim();

  it("makes no fetch of origin: the base and the factory branches are the factory repo's local branches", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-local-sbx-"));
    const repo = join(dir, "repo");
    git(dir, "init", "--quiet", "-b", "main", repo);
    // A remote that cannot be reached: any fetch of it would fail the test.
    git(repo, "remote", "add", "origin", "https://example.invalid/never.git");
    writeFileSync(join(repo, "README.md"), "hi\n");
    git(repo, "add", "-A");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "init");
    git(repo, "branch", "factory/wi_1");
    git(repo, "checkout", "--quiet", "factory/wi_1");
    writeFileSync(join(repo, "gate.ts"), "x\n");
    git(repo, "add", "-A");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "gate");
    git(repo, "checkout", "--quiet", "main");
    const main = git(repo, "rev-parse", "main");
    const branch = git(repo, "rev-parse", "factory/wi_1");

    const calls: string[][] = [];
    const sandbox = new NoOpSandbox(join(dir, "wt"), (cmd, opts) => (calls.push([...cmd]), runProcess(cmd, opts)), undefined, { local: true });
    const handle = await sandbox.create({ repo, branch: "factory/wi_1", base_ref: "main" });
    expect(handle.base_sha).toBe(main);
    expect(git(handle.workdir, "rev-parse", "HEAD")).toBe(branch);
    expect(git(handle.workdir, "rev-parse", "origin/main")).toBe(main);
    expect(await sandbox.updateBase({ repo, base_ref: "main" })).toBe(main);
    expect(await sandbox.fetchBranch({ repo, branch: "factory/wi_1" })).toBe(branch);
    expect(await sandbox.fetchBranch({ repo, branch: "factory/wi_none" })).toBeNull();
    const fresh = await sandbox.create({ repo, branch: "factory/wi_2", base_ref: "main" });
    expect(git(fresh.workdir, "rev-parse", "HEAD")).toBe(main);

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter((c) => c.includes("origin") && (c.includes("fetch") || c.includes("remote")))).toEqual([]);
    // Every fetch reads the factory repo's own path, never a remote.
    for (const c of calls.filter((c) => c.includes("fetch"))) expect(c).toContain(repo);
  });
});
