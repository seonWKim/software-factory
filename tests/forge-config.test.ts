import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Plugins, loadConfig } from "../src/compose.js";
import { GitHubForge } from "../src/impl/forge/github-forge.js";
import { GitHubClient } from "../src/impl/github/github-client.js";
import { TokenCredentials } from "../src/impl/github/token-credentials.js";
import type { Forge } from "../src/interfaces/forge.js";
import type { Secret, SecretName, SecretStore } from "../src/interfaces/secret-store.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { Controller } from "../src/core/controller.js";
import { FakeAuth, cleanScanner, config, silent } from "./helpers/fakes.js";
import { RecordingGitHubClient } from "./helpers/github.js";
import { newStore } from "./helpers/store.js";
import { REGISTRY, createPlugin, declaredSecrets, defaultPlugins, loadRegistry, selectPlugins, selectedSources, withPlugin } from "../src/plugins.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const REAL = JSON.parse(readFileSync(join(REPO_ROOT, "factory.config.json"), "utf8")) as Record<string, unknown>;

afterEach(() => {
  vi.unstubAllEnvs();
});

function root(config: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "sf-forge-"));
  mkdirSync(join(dir, "prompts"));
  for (const p of ["triage", "implement", "review", "resolve"]) writeFileSync(join(dir, "prompts", `${p}.md`), p);
  writeFileSync(join(dir, "factory.config.json"), JSON.stringify({ ...config, state_dir: "state", worktrees_dir: "wt" }));
  mkdirSync(join(dir, "secrets"));
  writeFileSync(join(dir, "secrets", ".env"), "MYSQL_PASSWORD=pw\nGITHUB_TOKEN=gh\n");
  vi.stubEnv("SOFTWARE_FACTORY_SECRETS_FILE", join(dir, "secrets", ".env"));
  return dir;
}

const withForge = (forge: unknown): Record<string, unknown> => ({ ...REAL, plugins: { ...(REAL.plugins as object), forge } });
/** The checked-in config with `source` instead of its sources, and `forge` when given (absent: left out). */
const withSources = (source: unknown, ...forge: unknown[]): Record<string, unknown> => {
  const { forge: _, ...plugins }: Record<string, unknown> = { ...(REAL.plugins as Record<string, unknown>), source };
  return { ...REAL, plugins: forge.length ? { ...plugins, forge: forge[0] } : plugins };
};

class MapSecrets implements SecretStore {
  async get(name: SecretName): Promise<Secret | null> {
    return { name, reveal: () => "gh", toJSON: () => `[secret ${name}]` };
  }
  async valuesForScan(): Promise<readonly string[]> {
    return [];
  }
}

const github = new GitHubClient(new TokenCredentials(new MapSecrets()));

describe("forge: an optional kind with no default", () => {
  it("is registered as Forge under plugins.forge, not a guard, with github and no default", () => {
    const entry = REGISTRY.forge;
    expect(entry.interface).toBe("Forge");
    expect(entry.configKey).toBe("plugins.forge");
    expect(entry.guard).toBe(false);
    expect(entry.optional).toBe(true);
    expect(Object.keys(entry.plugins)).toContain("github");
    expect(entry.defaults.fallback).toBeUndefined();
    expect(entry.defaults.platforms).toEqual({});
    for (const platform of ["darwin", "linux"]) expect(defaultPlugins(platform)).not.toHaveProperty("forge");
  });

  it("the github descriptor is kind forge, named github, with no default", async () => {
    const d = (await import("../src/impl/forge/github.plugin.js")).default;
    expect(d.kind).toBe("forge");
    expect(d.name).toBe("github");
    expect(d.default).toBeUndefined();
  });

  it("the registry loads with no default forge plugin", async () => {
    const registry = await loadRegistry([join(REPO_ROOT, "src", "impl")]);
    expect(registry.forge.defaults.fallback).toBeUndefined();
  });

  it("an optional kind's descriptor may not claim a default", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-forge-plugins-"));
    writeFileSync(join(dir, "x.plugin.js"), 'export default { kind: "forge", name: "x", default: true, create: () => ({}) };\n');
    await expect(loadRegistry([dir])).rejects.toThrow(/forge plugins take no default/);
  });
});

describe("forge: selection at startup", () => {
  it("absent with github-issues in plugins.source: the forge is github, with or without a plugins object (issue #273)", async () => {
    for (const cfg of [REAL, withSources("github-issues"), (({ plugins: _, ...rest }) => rest)(REAL)]) {
      const loaded = await loadConfig(root(cfg));
      expect(loaded.plugins.forge).toBe("github");
    }
  });

  it("absent without github-issues: no forge, so a local-only setup selects nothing that calls GitHub", async () => {
    for (const source of ["local", ["local"], []]) {
      const loaded = await loadConfig(root(withSources(source)));
      expect(loaded.plugins, JSON.stringify(source)).not.toHaveProperty("forge");
    }
  });

  it('"none" and other off values without github-issues: config loads, no forge selected, and no guard error', async () => {
    for (const off of ["none", null, false, ""]) {
      const loaded = await loadConfig(root(withSources(["local"], off)));
      expect(loaded.plugins, JSON.stringify(off)).not.toHaveProperty("forge");
    }
  });

  it("an off value next to github-issues fails at startup, naming plugins.forge and github-issues", async () => {
    for (const off of ["none", null, false, ""]) {
      const err = await loadConfig(root(withForge(off))).then(() => null, (e: Error) => e.message);
      expect(err, JSON.stringify(off)).toContain("plugins.forge");
      expect(err).toContain("github-issues");
      expect(err).not.toMatch(/guard/);
    }
  });

  it('"github": config loads and selects it', async () => {
    const loaded = await loadConfig(root(withForge("github")));
    expect(loaded.plugins.forge).toBe("github");
  });

  it("an unknown name fails, naming Forge and listing the available names", async () => {
    const err = await loadConfig(root(withForge("gitlab"))).then(
      () => null,
      (e: Error) => e.message,
    );
    expect(err).toContain("Forge");
    expect(err).toContain("gitlab");
    expect(err).toContain("plugins.forge");
    for (const name of Object.keys(REGISTRY.forge.plugins)) expect(err).toContain(name);
    expect(err).not.toMatch(/guard/);
  });

  it("a guard left out still fails while the forge is set", () => {
    const { secrets: _, ...plugins } = REAL.plugins as Record<string, unknown>;
    expect(() => selectPlugins(REGISTRY, { store: { type: "sqlite" }, auth: "none", plugins: { ...plugins, forge: "github" } })).toThrow(
      /SecretStore is a guard/,
    );
  });

  it("declared secrets do not change when no forge is selected", async () => {
    const loaded = await loadConfig(root(REAL));
    const withGithub = await loadConfig(root(withForge("github")));
    expect(declaredSecrets(withGithub.registry, withGithub.plugins).map((d) => d.name).sort()).toEqual(
      declaredSecrets(loaded.registry, loaded.plugins).map((d) => d.name).sort(),
    );
  });
});

describe("forge: building", () => {
  const spyRegistry = () => {
    const made: string[] = [];
    const registry = withPlugin(REGISTRY, "forge", "spy", () => {
      made.push("spy");
      return {} as Forge;
    });
    return { registry, made };
  };

  it("absent or none without github-issues: Plugins.forge builds nothing and returns null", async () => {
    const { registry, made } = spyRegistry();
    for (const cfg of [withSources(["local"]), withSources(["local"], "none")]) {
      const loaded = await loadConfig(root(cfg), { registry });
      expect(await new Plugins(loaded).forge(github)).toBeNull();
    }
    expect(made).toEqual([]);
  });

  it("a selected forge is built through the registry", async () => {
    const { registry, made } = spyRegistry();
    const loaded = await loadConfig(root(withForge("spy")), { registry });
    expect(await new Plugins(loaded).forge(github)).toEqual({});
    expect(made).toEqual(["spy"]);
  });

  it('"github" builds a GitHubForge offering the PR events, facts and writes', async () => {
    const loaded = await loadConfig(root(withForge("github")));
    const forge = (await new Plugins(loaded).forge(github)) as Forge;
    expect(forge).toBeInstanceOf(GitHubForge);
    for (const m of ["poll", "prRef", "prNumberOf", "postPrComment", "setPrStatus", "prChecks", "prFiles", "labelAddedBy", "commitAuthor", "closePr"] as const) {
      expect(forge[m]).toBeTypeOf("function");
    }
    expect(forge.handover_cursor).toBe("intake:github_issue");
  });

  it("built without the store, Clock and log, the github forge cannot poll; with them it can", async () => {
    const loaded = await loadConfig(root(withForge("github")));
    const bare = (await new Plugins(loaded).forge(github))!;
    await expect(bare.poll(null)).rejects.toThrow(/PollContext/);
    const client = new RecordingGitHubClient();
    const { store } = await newStore();
    const clock = new FakeClock("2026-11-07T00:00:00Z");
    const full = (await new Plugins(loaded).forge(client, { store, clock, log: silent }))!;
    const { events } = await full.poll(null);
    expect(events).toEqual([]);
    // The closed and the open PR list of the configured repository.
    expect(client.calls.map((c) => c.path.split("?")[0]!.replace(/^\/repos\/[^/]+\/[^/]+/, ""))).toEqual(["/pulls", "/pulls"]);
  });
});

describe("forge: a setup without GitHub makes no GitHub call (issue #273)", () => {
  it("only a non-GitHub source and no forge: a poll tick makes zero GitHub API calls and yields no PR event", async () => {
    const loaded = await loadConfig(root(withSources(["local"])));
    const client = new RecordingGitHubClient();
    const p = new Plugins(loaded);
    const { store, clock } = await newStore();
    expect(await p.forge(client, { store, clock, log: silent })).toBeNull();
    const sources = [];
    for (const name of selectedSources(loaded.plugins)) {
      sources.push(await createPlugin(loaded.registry, "source", name, { ...p.base, github: client, store, secrets: new MapSecrets(), scanner: cleanScanner, log: silent, clock }));
    }
    const controller = new Controller({ store, sources, forge: null, auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner });
    await controller.tickIntake();
    await controller.tickIntake();
    expect(client.calls).toEqual([]);
    expect(await store.getCursor("forge:github_issue")).toBeNull();
  });
});
