import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PluginKind, Registry } from "../src/plugin-api.js";

// The solo default (design 08-plugins): no GitHub plugin selected, so startup makes no GitHub call and a solo
// config loads no GitHub implementation module. Only the descriptors under src/impl/github/ load (the registry
// discovers every descriptor), plus the implementation of a guard the solo selection uses there: none today, as
// solo's guards (env-file secrets, pattern egress, local broker) live elsewhere.

const GITHUB_DIR = join(import.meta.dirname, "..", "src", "impl", "github");
const DESCRIPTOR = /\.(?:plugin|grant)\.ts$/;
const REAL = JSON.parse(readFileSync(join(import.meta.dirname, "..", "factory.config.json"), "utf8")) as Record<string, unknown>;

/** The solo default: the local source, local auth, the local broker, static grants only; github_auth left as shipped. */
const SOLO = {
  auth: "local",
  permissions: { grants: ["static"] },
  plugins: { ...(REAL.plugins as object), awake: "none", updater: "none", source: ["local"], broker: "local" },
};

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "sf-solo-"));
  mkdirSync(join(dir, "prompts"));
  for (const p of ["triage", "implement", "review", "resolve"]) writeFileSync(join(dir, "prompts", `${p}.md`), p);
  writeFileSync(join(dir, "factory.config.json"), JSON.stringify({ ...REAL, ...SOLO, store: { type: "sqlite" }, state_dir: "state", worktrees_dir: "wt" }));
  writeFileSync(join(dir, "secrets.env"), "MYSQL_PASSWORD=pw\n");
  vi.stubEnv("SOFTWARE_FACTORY_SECRETS_FILE", join(dir, "secrets.env"));
  return dir;
}

/** The GitHub implementation modules: every file under src/impl/github/ but its descriptors. */
const implementations = readdirSync(GITHUB_DIR).filter((f) => f.endsWith(".ts") && !DESCRIPTOR.test(f)).sort();
/** Which of them were loaded, by file name: filled by the module spies below. */
const loaded = new Set<string>();
/** Which registry plugins were built, as `kind:name`: filled by the registry spy. */
const created: string[] = [];

/** `registry` with every plugin factory wrapped to record its build. */
function spied(registry: Registry): Registry {
  const out = { ...registry } as Record<PluginKind, Registry[PluginKind]>;
  for (const kind of Object.keys(registry) as PluginKind[]) {
    const entry = registry[kind];
    const plugins = Object.fromEntries(
      Object.entries(entry.plugins).map(([name, create]) => [name, (ctx: never) => (created.push(`${kind}:${name}`), (create as (c: never) => unknown)(ctx))]),
    );
    out[kind] = { ...entry, plugins } as Registry[PluginKind];
  }
  return out as Registry;
}

let compose: typeof import("../src/compose.js");
let plugins: typeof import("../src/plugins.js");

beforeAll(async () => {
  vi.resetModules();
  for (const file of implementations) {
    vi.doMock(join(GITHUB_DIR, file), async (importOriginal) => {
      loaded.add(file);
      return importOriginal();
    });
  }
  compose = await import("../src/compose.js");
  plugins = await import("../src/plugins.js");
});

afterAll(() => {
  vi.unstubAllEnvs();
  for (const file of implementations) vi.doUnmock(join(GITHUB_DIR, file));
  vi.resetModules();
});

describe("solo: no GitHub plugin selected", () => {
  it("resolves its project with no GitHub call", async () => {
    const fail = () => expect.fail("a solo start called GitHub's repository lookup");
    const registry = plugins.withPlugin(plugins.REGISTRY, "github_auth", "token", () => ({
      credentials: { token: async () => fail() },
      api: new Proxy({}, { get: (_t, key) => (key === "then" ? undefined : fail) }),
    }) as never);
    const loadedConfig = await compose.loadConfig(root(), { registry });
    expect(loadedConfig.config.local_only).toBe(true);
    const built = await compose.build(loadedConfig, { repoLookup: { repoIdentity: async () => fail() } });
    try {
      expect(built.project).toEqual(compose.localProject(loadedConfig.config.repo));
    } finally {
      await built.close();
    }
  });

  it("loads no module from src/impl/github/ but its descriptors, and builds no GitHub plugin (registry spy)", async () => {
    // The plugins the GitHub descriptors register, as `kind:name`.
    const github: string[] = [];
    for (const file of readdirSync(GITHUB_DIR).filter((f) => /\.plugin\.ts$/.test(f))) {
      const d = ((await import(join(GITHUB_DIR, file))) as { default: { kind: string; name: string } }).default;
      github.push(`${d.kind}:${d.name}`);
    }
    expect(github).toContain("forge:github");
    expect(implementations).toContain("github-client.ts");

    const loadedConfig = await compose.loadConfig(root(), { registry: spied(plugins.REGISTRY) });
    const built = await compose.build(loadedConfig);
    await built.close();

    expect(created).toContain("broker:local");
    expect(created.filter((c) => github.includes(c))).toEqual([]);
    expect([...loaded]).toEqual([]);
  });
});
