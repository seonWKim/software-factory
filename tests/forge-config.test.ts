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
import { REGISTRY, declaredSecrets, defaultPlugins, loadRegistry, selectPlugins, withPlugin } from "../src/plugins.js";

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
  it("absent: config loads and the selection has no forge, with or without a plugins object", async () => {
    for (const cfg of [REAL, (({ plugins: _, ...rest }) => rest)(REAL)]) {
      const loaded = await loadConfig(root(cfg));
      expect(loaded.plugins.forge).toBeUndefined();
      expect(loaded.plugins).not.toHaveProperty("forge");
    }
  });

  it('"none" and other off values: config loads, no forge selected, and no guard error', async () => {
    for (const off of ["none", null, false, ""]) {
      const loaded = await loadConfig(root(withForge(off)));
      expect(loaded.plugins, JSON.stringify(off)).not.toHaveProperty("forge");
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
      return new GitHubForge({} as never);
    });
    return { registry, made };
  };

  it("absent or none: Plugins.forge builds nothing and returns null", async () => {
    const { registry, made } = spyRegistry();
    for (const cfg of [REAL, withForge("none")]) {
      const loaded = await loadConfig(root(cfg), { registry });
      expect(await new Plugins(loaded).forge(github)).toBeNull();
    }
    expect(made).toEqual([]);
  });

  it("a selected forge is built through the registry", async () => {
    const { registry, made } = spyRegistry();
    const loaded = await loadConfig(root(withForge("spy")), { registry });
    expect(await new Plugins(loaded).forge(github)).toBeInstanceOf(GitHubForge);
    expect(made).toEqual(["spy"]);
  });

  it('"github" builds a GitHubForge offering the PR facts', async () => {
    const loaded = await loadConfig(root(withForge("github")));
    const forge = (await new Plugins(loaded).forge(github)) as Forge;
    expect(forge).toBeInstanceOf(GitHubForge);
    for (const m of ["prChecks", "prFiles", "commitAuthor", "closePr"] as const) expect(forge[m]).toBeTypeOf("function");
  });

  it("GitHubForge passes each PR fact through to the GitHub source", async () => {
    const calls: unknown[][] = [];
    const rec =
      <T>(name: string, out: T) =>
      async (...args: unknown[]) => {
        calls.push([name, ...args]);
        return out;
      };
    const forge = new GitHubForge({
      prChecks: rec("prChecks", { state: "passed" as const }),
      prFiles: rec("prFiles", ["a.ts"]),
      commitAuthor: rec("commitAuthor", null),
      closePr: rec("closePr", "closed" as const),
    });
    const input = { pr_number: 4, closed: { type: "github", id: "1" } as never, marker: "m", body: () => "b" };
    expect(await forge.prChecks(1)).toEqual({ state: "passed" });
    expect(await forge.prFiles(2)).toEqual(["a.ts"]);
    expect(await forge.commitAuthor("abc")).toBeNull();
    expect(await forge.closePr(input)).toBe("closed");
    expect(calls).toEqual([["prChecks", 1], ["prFiles", 2], ["commitAuthor", "abc"], ["closePr", input]]);
  });
});
