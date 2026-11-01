import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  IMPL_DIR,
  PLUGIN_KINDS,
  REGISTRY,
  createPlugin,
  defaultPlugins,
  findPluginFiles,
  loadRegistry,
  selectPlugins,
} from "../src/plugins.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const REAL = JSON.parse(readFileSync(join(REPO_ROOT, "factory.config.json"), "utf8")) as Record<string, unknown>;
const API_URL = pathToFileURL(join(REPO_ROOT, "src", "plugin-api.ts")).href;

/** A temp directory holding the given files (relative path → content). */
function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "sf-discovery-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

/** A descriptor source file for a test clock plugin. */
const clockPlugin = (name: string, extra = ""): string =>
  `import { definePlugin } from ${JSON.stringify(API_URL)};\n` +
  `export default definePlugin({ kind: "clock", name: ${JSON.stringify(name)}, ${extra}\n` +
  `  create: () => ({ name: ${JSON.stringify(name)}, now: () => new Date(0), sleep: async () => {} }) });\n`;

const failure = (p: Promise<unknown>): Promise<string | null> =>
  p.then(
    () => null,
    (e: Error) => e.message,
  );

describe("plugin discovery: finding descriptor files", () => {
  it("the source tree holds 19 *.plugin.ts descriptors, sorted by path, and no other file", () => {
    const files = findPluginFiles([IMPL_DIR]);
    expect(files.length).toBe(19);
    expect(files).toEqual([...files].sort());
    for (const f of files) expect(f).toMatch(/\.plugin\.ts$/);
    for (const f of files) expect(relative(IMPL_DIR, f).startsWith("..")).toBe(false);
  });

  it("in a source tree: finds *.plugin.ts, ignores *.d.ts and other files", () => {
    const dir = tree({
      "b/b.plugin.ts": "",
      "a.plugin.ts": "",
      "a.plugin.d.ts": "",
      "c.ts": "",
      "plugin.ts": "",
      "d.plugin.ts.bak": "",
    });
    expect(findPluginFiles([dir]).map((f) => relative(dir, f))).toEqual(["a.plugin.ts", `b${sep}b.plugin.ts`]);
  });

  it("in a built tree: finds *.plugin.js, ignores *.d.ts and source maps", () => {
    const dir = tree({
      "z/z.plugin.js": "",
      "a.plugin.js": "",
      "a.plugin.d.ts": "",
      "a.plugin.js.map": "",
      "a.plugin.d.ts.map": "",
      "helper.js": "",
    });
    expect(findPluginFiles([dir]).map((f) => relative(dir, f))).toEqual(["a.plugin.js", `z${sep}z.plugin.js`]);
  });

  it("imports and registers built *.plugin.js descriptors", async () => {
    const js = (name: string) =>
      `export default { kind: "clock", name: ${JSON.stringify(name)}, create: () => ({ now: () => new Date(0), sleep: async () => {} }) };\n`;
    const dir = tree({ "b.plugin.js": js("js-b"), "a.plugin.js": js("js-a") });
    const registry = await loadRegistry([IMPL_DIR, dir]);
    expect(Object.keys(registry.clock.plugins)).toEqual(["system", "js-a", "js-b"]);
  });
});

describe("plugin discovery: the built-in registry", () => {
  it("REGISTRY is the registry loaded from src/impl", async () => {
    const loaded = await loadRegistry([IMPL_DIR]);
    for (const kind of PLUGIN_KINDS) {
      expect(Object.keys(loaded[kind].plugins), kind).toEqual(Object.keys(REGISTRY[kind].plugins));
    }
  });

  it("defaultPlugins keeps today's values on darwin and linux", () => {
    const fixed = {
      sandbox: "noop",
      runner: "claude-code",
      llm: "claude-cli",
      secrets: "env-file",
      egress: "pattern",
      broker: "github",
      storage: "fs",
      source: "github-issues",
      capability: "list-all",
      clock: "system",
      updater: "git-worktree",
    };
    expect(defaultPlugins("darwin")).toEqual({ ...fixed, awake: "caffeinate" });
    expect(defaultPlugins("linux")).toEqual({ ...fixed, awake: "none" });
  });

  it("src/plugins.ts names no plugin and imports no implementation", () => {
    const text = readFileSync(join(REPO_ROOT, "src", "plugins.ts"), "utf8");
    const imports = [...text.matchAll(/^\s*import\s+(type\s+)?[^"']*from\s+["']([^"']+)["']/gm)];
    for (const m of imports) {
      if (!m[1]) expect(m[2], m[0]).not.toMatch(/\/impl\//);
    }
    for (const kind of PLUGIN_KINDS) {
      for (const name of Object.keys(REGISTRY[kind].plugins)) {
        if (name === "none") continue; // also the guard rule's disabling value, which this file must name
        expect(text, `${kind} plugin "${name}"`).not.toContain(`"${name}"`);
      }
    }
  });
});

describe("plugin discovery: a new plugin file", () => {
  it("is discovered and selectable through selectPlugins, with no other file changed", async () => {
    const dir = tree({ "temp-clock.plugin.ts": clockPlugin("temp-clock") });
    const registry = await loadRegistry([IMPL_DIR, dir]);
    expect(Object.keys(registry.clock.plugins)).toContain("temp-clock");
    const sel = selectPlugins(
      registry,
      { store: { type: "sqlite" }, auth: "none", plugins: { ...(REAL.plugins as object), clock: "temp-clock" } },
      { platform: "linux" },
    );
    expect(sel.clock).toBe("temp-clock");
    const clock = await createPlugin(registry, "clock", sel.clock, {} as never);
    expect((clock as unknown as { name: string }).name).toBe("temp-clock");
    expect(clock.now()).toEqual(new Date(0));
    // The built-in registry is untouched.
    expect(Object.keys(REGISTRY.clock.plugins)).not.toContain("temp-clock");
  });

  it("declares its secrets in the descriptor", async () => {
    const dir = tree({
      "s.plugin.ts": clockPlugin(
        "secret-clock",
        `secrets: [{ name: "TEST_CLOCK_TOKEN", purpose: "reads the test clock" }],`,
      ),
    });
    const registry = await loadRegistry([IMPL_DIR, dir]);
    expect(registry.clock.secrets["secret-clock"]!.map((d) => d.name)).toEqual(["TEST_CLOCK_TOKEN"]);
    expect(registry.clock.secrets.system).toEqual([]);
  });
});

describe("plugin discovery: bad descriptors fail startup", () => {
  it("an unknown kind names the file", async () => {
    const dir = tree({ "x/bad.plugin.ts": `export default { kind: "telepathy", name: "x", create: () => ({}) };\n` });
    const err = await failure(loadRegistry([IMPL_DIR, dir]));
    expect(err).toContain(join(dir, "x", "bad.plugin.ts"));
    expect(err).toContain("telepathy");
  });

  it("a file without a descriptor names the file", async () => {
    const dir = tree({ "empty.plugin.ts": "export const nothing = 1;\n" });
    const err = await failure(loadRegistry([IMPL_DIR, dir]));
    expect(err).toContain(join(dir, "empty.plugin.ts"));
  });

  it("two plugins with one name under one kind name the kind, the name and both files", async () => {
    const dir = tree({ "dup.plugin.ts": clockPlugin("system") });
    const err = await failure(loadRegistry([IMPL_DIR, dir]));
    expect(err).toContain("clock");
    expect(err).toContain('"system"');
    expect(err).toContain(join(IMPL_DIR, "clock", "system.plugin.ts"));
    expect(err).toContain(join(dir, "dup.plugin.ts"));
  });

  it("the same name under two kinds is fine", async () => {
    const dir = tree({ "sys.plugin.ts": clockPlugin("noop") });
    const registry = await loadRegistry([IMPL_DIR, dir]);
    expect(Object.keys(registry.clock.plugins)).toContain("noop");
    expect(Object.keys(registry.sandbox.plugins)).toContain("noop");
  });

  it("a non-guard kind with no default names the kind and its files", async () => {
    const dir = tree({ "only.plugin.ts": clockPlugin("only-clock") });
    const err = await failure(loadRegistry([dir]));
    expect(err).toMatch(/Clock \(clock\) has no default/);
    expect(err).toContain(join(dir, "only.plugin.ts"));
  });

  it("two defaults for every platform name the kind and both files", async () => {
    const dir = tree({ "second.plugin.ts": clockPlugin("second-clock", "default: true,") });
    const err = await failure(loadRegistry([IMPL_DIR, dir]));
    expect(err).toMatch(/Clock \(clock\) has two defaults/);
    expect(err).toContain(join(IMPL_DIR, "clock", "system.plugin.ts"));
    expect(err).toContain(join(dir, "second.plugin.ts"));
  });

  it("two defaults for the same platform name the kind, the platform and both files", async () => {
    const dir = tree({
      "a.plugin.ts": `export default { kind: "awake", name: "mac2", create: () => ({}), default: { platforms: ["darwin"] } };\n`,
    });
    const err = await failure(loadRegistry([IMPL_DIR, dir]));
    expect(err).toMatch(/KeepAwake \(awake\) has two defaults for darwin/);
    expect(err).toContain(join(IMPL_DIR, "awake", "caffeinate.plugin.ts"));
    expect(err).toContain(join(dir, "a.plugin.ts"));
  });

  it("store and auth take no default: their config keys pick one", async () => {
    const dir = tree({ "s.plugin.ts": `export default { kind: "auth", name: "x", create: () => ({}), default: true };\n` });
    const err = await failure(loadRegistry([IMPL_DIR, dir]));
    expect(err).toMatch(/auth/);
    expect(err).toContain(join(dir, "s.plugin.ts"));
  });

  it("a guard kind with no plugin fails", async () => {
    const err = await failure(loadRegistry([tree({})]));
    for (const guard of ["SecretStore", "EgressScanner", "ToolBroker"]) {
      expect(err).toMatch(new RegExp(`${guard} \\(\\w+\\) is a guard and has no plugin`));
    }
  });

  it("a guard plugin cannot be named after a disabling value", async () => {
    const dir = tree({ "n.plugin.ts": `export default { kind: "egress", name: "none", create: () => ({}) };\n` });
    const err = await failure(loadRegistry([IMPL_DIR, dir]));
    expect(err).toMatch(/means disabled/);
    expect(err).toContain(join(dir, "n.plugin.ts"));
  });
});

describe("plugin discovery: the build", () => {
  it("npm run build empties dist/ before tsc, so a deleted plugin leaves no stale descriptor", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    const build = pkg.scripts.build!;
    expect(build).toMatch(/rmSync\('dist'/);
    expect(build.indexOf("rmSync")).toBeLessThan(build.indexOf("tsc"));
    for (const script of ["factory", "setup"]) expect(pkg.scripts[script], script).toMatch(/npm run (--silent )?build/);
  });
});
