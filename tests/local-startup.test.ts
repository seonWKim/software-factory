import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { build, loadConfig, localProject, selectsGitHub } from "../src/compose.js";
import { readStoredProject } from "../src/core/project-labels.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { LocalForge } from "../src/impl/forge/local-forge.js";
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

/** The solo default: the local source and the local broker. */
const SOLO = {
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

describe("the removed auth and permissions keys (design 08-permissions, One owner)", () => {
  it("a config that still has one loads and logs exactly one warning that names it", async () => {
    for (const [key, value] of [["auth", "github"], ["permissions", { grants: ["static"] }]] as const) {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const loaded = await loadConfig(root({ ...SOLO, [key]: value }), { registry: recordingRegistry().registry });
        expect(loaded.config.local_only).toBe(true);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0]![0])).toContain(`"${key}"`);
      } finally {
        warn.mockRestore();
      }
    }
  });

  it("a config without them logs no warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await loadConfig(root(SOLO), { registry: recordingRegistry().registry });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("the one rule: is a GitHub plugin selected", () => {
  const sel = (over: Partial<Selection>): Selection => ({ ...({ source: "local", broker: "local" } as Selection), ...over });

  it("no GitHub source, broker or forge: the local path", () => {
    expect(selectsGitHub(sel({}))).toBe(false);
  });

  it("any one GitHub plugin selects GitHub", () => {
    expect(selectsGitHub(sel({ sources: ["local", "github-issues"] }))).toBe(true);
    expect(selectsGitHub(sel({ source: "github-issues" }))).toBe(true);
    expect(selectsGitHub(sel({ broker: "github" }))).toBe(true);
    expect(selectsGitHub(sel({ forge: "github" }))).toBe(true);
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
      // No forge selected: none is the forge, and links are read through the local forge the registry builds.
      expect(loaded.plugins.forge).toBeUndefined();
      expect(built.controller.kernel.forge).toBeNull();
      expect(built.controller.kernel.links).toBeInstanceOf(LocalForge);
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

describe("build() with a GitHub config", () => {
  it("reads links through the github forge the kernel holds, and builds no local forge", async () => {
    const { registry } = recordingRegistry();
    let localForges = 0;
    const counting = withPlugin(registry, "forge", "local", (c) => (localForges++, REGISTRY.forge.plugins.local!(c)));
    const github = { ...SOLO, plugins: { ...SOLO.plugins, source: ["github-issues"], broker: "github" } };
    const loaded = await loadConfig(root(github), { registry: counting });
    const repoLookup = { repoIdentity: async (r: { owner: string; name: string }) => ({ node_id: "R_1", ...r, host: "github.com" }) };
    const built = await build(loaded, { clock: new FakeClock(), repoLookup });
    try {
      expect(loaded.plugins.forge).toBe("github");
      expect(built.controller.kernel.forge).not.toBeNull();
      expect(built.controller.kernel.links).toBe(built.controller.kernel.forge);
      expect(localForges).toBe(0);
    } finally {
      await built.close();
    }
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
