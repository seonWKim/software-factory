import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Loaded, Plugins, build, fillPrompt, loadConfig } from "../src/compose.js";
import type { WorkerDeps } from "../src/worker/index.js";
import { WorkerPool } from "../src/worker/index.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { Bm25CapabilitySearch } from "../src/impl/capability/bm25-capability-search.js";
import { PLUGIN_KINDS, REGISTRY, createPlugin } from "../src/plugins.js";
import { LEARNED_PACK_DIR, PROJECT_PACK_DIR, mainCheckout, mergeSections, packSkills } from "../src/packs/packs.js";
import { issue, newStore, system } from "./helpers/store.js";
import {
  FakeBroker, FakeRunner, FakeSandbox, MemoryStorage, cleanScanner, config as fakeConfig, fakeRepoLookup, silent, triageSpec, waitFor,
} from "./helpers/fakes.js";
import { git } from "./helpers/git-fixture.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const REAL = JSON.parse(readFileSync(join(REPO_ROOT, "factory.config.json"), "utf8")) as Record<string, unknown>;
const SQLITE = { ...REAL, store: { type: "sqlite" }, plugins: { ...(REAL.plugins as object), awake: "none" } };

const BASE_TRIAGE = [
  "You are the triage agent.",
  "",
  "## Scope",
  "",
  "Base scope rules.",
  "",
  "## Output",
  "",
  "Base output rules.",
  "",
].join("\n");

afterEach(() => {
  vi.unstubAllEnvs();
});

const temp = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/**
 * A code root (the base pack: prompts/, a factory.config.json) and a separate repo folder the config's repo.path
 * names. `config` is merged into the checked-in config on SQLite.
 */
function fixture(config: Record<string, unknown> = {}, repo = temp("sf-packs-repo-")) {
  const codeRoot = temp("sf-packs-code-");
  write(join(codeRoot, "prompts", "triage.md"), BASE_TRIAGE);
  for (const p of ["implement", "review"]) write(join(codeRoot, "prompts", `${p}.md`), `${p} base\n`);
  const file = { ...SQLITE, repo: { ...(REAL.repo as object), path: repo }, state_dir: "state", worktrees_dir: "wt", ...config };
  write(join(codeRoot, "factory.config.json"), JSON.stringify(file));
  write(join(codeRoot, "secrets", ".env"), "MYSQL_PASSWORD=pw\nGITHUB_TOKEN=gh\n");
  vi.stubEnv("SOFTWARE_FACTORY_SECRETS_FILE", join(codeRoot, "secrets", ".env"));
  return { codeRoot, repo, project: join(repo, PROJECT_PACK_DIR), learned: join(codeRoot, "state", LEARNED_PACK_DIR) };
}

/** A non-guard plugin descriptor as plain JS: a KeepAwake that does nothing, tagged so the test can find it. */
function awakePlugin(name: string): string {
  return `export default { kind: "awake", name: ${JSON.stringify(name)}, create: () => ({ pack: ${JSON.stringify(name)}, async hold() {}, async release() {} }) };\n`;
}

const load = (codeRoot: string) => loadConfig(codeRoot);

async function loadError(codeRoot: string): Promise<Error> {
  const err = await load(codeRoot).then(() => null, (e: Error) => e);
  if (!err) throw new Error("loadConfig succeeded");
  return err;
}

/** One triage run through a worker pool with the fake runner; returns the system prompt it received. */
async function triagePrompt(loaded: Loaded): Promise<string> {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  await store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "t1" } });
  const runner = new FakeRunner({ triage: () => ({ output: triageSpec }) });
  const pool = new WorkerPool({
    id_prefix: "host:1", store, sandbox: new FakeSandbox(), runner, broker: new FakeBroker(), storage: new MemoryStorage(),
    clock, config: fakeConfig, prompts: loaded.prompts, log: silent, scanner: cleanScanner, toolEnv: {}, awake: new NoKeepAwake(),
  });
  const stop = new AbortController();
  const loops = pool.run(stop.signal);
  await waitFor(() => runner.specs.length > 0, "a triage run");
  stop.abort();
  await loops;
  return runner.specs[0]!.system_prompt;
}

describe("packs: prompts", () => {
  it("a project pack's triage section replaces the base section of the same heading; other sections keep the base text (fake runner)", async () => {
    const f = fixture();
    write(join(f.project, "prompts", "triage.md"), "## Scope\n\nProject scope rules.\n");
    const prompt = await triagePrompt(await load(f.codeRoot));
    expect(prompt).toContain("You are the triage agent.");
    expect(prompt).toContain("## Scope\n\nProject scope rules.\n\n## Output");
    expect(prompt).not.toContain("Base scope rules.");
    expect(prompt).toContain("Base output rules.");
  });

  it("layers merge in order: learned after project; a section no lower layer has is added at the end", async () => {
    const f = fixture();
    write(join(f.project, "prompts", "triage.md"), "ignored preamble\n\n## Scope\n\nProject scope.\n\n## Extra\n\nProject extra.\n");
    write(join(f.learned, "prompts", "triage.md"), "## Scope\n\nLearned scope.\n");
    const { prompts } = await load(f.codeRoot);
    expect(prompts.triage).toContain("## Scope\n\nLearned scope.\n\n## Output");
    expect(prompts.triage).not.toContain("Project scope.");
    expect(prompts.triage).not.toContain("ignored preamble");
    expect(prompts.triage.indexOf("## Extra")).toBeGreaterThan(prompts.triage.indexOf("## Output"));
    expect(prompts.triage).toContain("Project extra.");
  });

  it("packs.order puts org after project when asked", async () => {
    const org = temp("sf-packs-org-");
    write(join(org, "prompts", "triage.md"), "## Scope\n\nOrg scope.\n");
    const f = fixture({ packs: { org, order: ["base", "project", "org", "learned"] } });
    write(join(f.project, "prompts", "triage.md"), "## Scope\n\nProject scope.\n");
    expect((await load(f.codeRoot)).prompts.triage).toContain("Org scope.");
    const g = fixture({ packs: { org } });
    write(join(g.project, "prompts", "triage.md"), "## Scope\n\nProject scope.\n");
    expect((await load(g.codeRoot)).prompts.triage).toContain("Project scope.");
  });

  it("an optional prompt only a pack has is used whole", async () => {
    const f = fixture();
    write(join(f.project, "prompts", "resolve.md"), "Project resolve.\n");
    expect((await load(f.codeRoot)).prompts.resolve).toBe("Project resolve.\n");
  });

  it("merging with no section of the overlay keeps the base text exactly; a heading inside a code fence is not a section", () => {
    expect(mergeSections(BASE_TRIAGE, "")).toBe(BASE_TRIAGE);
    expect(mergeSections(BASE_TRIAGE, "only a preamble\n")).toBe(BASE_TRIAGE);
    const fenced = "Intro\n\n```\n## Scope\n```\n\n## Output\n\nBase.\n";
    expect(mergeSections(fenced, "## Scope\n\nNew.\n")).toBe("Intro\n\n```\n## Scope\n```\n\n## Output\n\nBase.\n\n## Scope\n\nNew.\n");
  });

  it("the checked-in prompts load unchanged: the base pack is the code root's prompts/", async () => {
    const loaded = await loadConfig(REPO_ROOT, { configFile: join(fixture().codeRoot, "factory.config.json") });
    expect(loaded.packs[0]).toEqual({ layer: "base", dir: REPO_ROOT });
    for (const name of ["triage", "implement", "review", "resolve", "improve"] as const) {
      const base = readFileSync(join(REPO_ROOT, "prompts", `${name}.md`), "utf8");
      const filled = fillPrompt(base, loaded.config.repo, loaded.plugins.forge ?? "local", loaded.config.toolchain);
      if (name === "triage") expect(loaded.prompts.triage.startsWith(filled.trimEnd())).toBe(true);
      else expect(loaded.prompts[name]).toBe(filled);
    }
  });
});

describe("packs: skills", () => {
  it("a project pack's skills/<name>.md is listed by the capability search as kind skill; no file under src/ or the code root's skills/ changes", async () => {
    const f = fixture({ plugins: { ...SQLITE.plugins, capability: "list-all" } });
    write(join(f.project, "skills", "deploy.md"), "# Deploy the zebra\n\nHow to deploy the zebra service.\n");
    const srcBefore = readdirSync(join(REPO_ROOT, "src"), { recursive: true }).length;
    const loaded = await load(f.codeRoot);
    const skillId = join(f.project, "skills", "deploy.md");
    // The default plugin (list-all), built by build() through the registry.
    const built = await build(loaded, { clock: new FakeClock(), repoLookup: fakeRepoLookup });
    try {
      const capability = (built.worker as unknown as { d: WorkerDeps }).d.capability!;
      expect(await capability.search("zebra", 8)).toEqual([{ id: skillId, kind: "skill", name: "Deploy the zebra", summary: "How to deploy the zebra service." }]);
    } finally {
      await built.close();
    }
    // BM25 with the packs' skill folders.
    const bm25 = new Bm25CapabilitySearch(f.codeRoot, [join(f.project, "skills")]);
    expect(await bm25.search("zebra", 8)).toEqual([expect.objectContaining({ id: skillId, kind: "skill" })]);
    expect(readdirSync(join(REPO_ROOT, "src"), { recursive: true }).length).toBe(srcBefore);
    expect(readdirSync(f.codeRoot)).not.toContain("skills");
  });

  it("base skills come first, by their code-root path", async () => {
    const f = fixture();
    write(join(f.codeRoot, "skills", "a.md"), "# A\n\nbase skill\n");
    write(join(f.project, "skills", "b.md"), "# B\n\nproject skill\n");
    expect(packSkills((await load(f.codeRoot)).packs).map((c) => c.id)).toEqual(["skills/a.md", join(f.project, "skills", "b.md")]);
  });
});

describe("packs: plugins", () => {
  it("a project pack's *.plugin.js is selectable by name and built through createPlugin; REGISTRY is unchanged", async () => {
    const f = fixture({ plugins: { ...SQLITE.plugins, awake: "pack-awake" } });
    write(join(f.project, "plugins", "pack-awake.plugin.js"), awakePlugin("pack-awake"));
    const loaded = await load(f.codeRoot);
    expect(loaded.plugins.awake).toBe("pack-awake");
    const awake = await createPlugin(loaded.registry, "awake", "pack-awake", { ...new Plugins(loaded).base, clock: new FakeClock() });
    expect((awake as unknown as { pack: string }).pack).toBe("pack-awake");
    expect(Object.keys(REGISTRY.awake.plugins)).not.toContain("pack-awake");
  });

  for (const [kind, guard] of [["secrets", "SecretStore"], ["egress", "EgressScanner"], ["broker", "ToolBroker"]] as const) {
    for (const layer of ["base", "org", "project", "learned"] as const) {
      it(`a ${layer} pack that declares a ${guard} fails startup, naming the file and the guard; the registry is unchanged`, async () => {
        const org = temp("sf-packs-org-");
        const f = fixture({ packs: { org } });
        const dir = { base: f.codeRoot, org, project: f.project, learned: f.learned }[layer];
        const file = join(dir, "plugins", "guard.plugin.js");
        write(file, `export default { kind: "${kind}", name: "pack-${kind}-${layer}", create: () => ({}) };\n`);
        const before = Object.keys(REGISTRY[kind].plugins);
        const err = await loadError(f.codeRoot);
        expect(err.message).toContain(file);
        expect(err.message).toContain(guard);
        expect(Object.keys(REGISTRY[kind].plugins)).toEqual(before);
      });
    }
  }

  it("on a shared store a project pack's plugin is refused, naming the file; an org pack's plugin is allowed", async () => {
    const mysql = { store: { type: "mysql", host: "localhost", port: 3306, database: "sf", user: "factory" } };
    const f = fixture(mysql);
    const file = join(f.project, "plugins", "pack-awake.plugin.js");
    write(file, awakePlugin("pack-awake-project"));
    const err = await loadError(f.codeRoot);
    expect(err.message).toContain(file);
    expect(err.message).toContain("shared store");

    const org = temp("sf-packs-org-");
    write(join(org, "plugins", "org-awake.plugin.js"), awakePlugin("org-awake"));
    const g = fixture({ ...mysql, packs: { org }, plugins: { ...SQLITE.plugins, awake: "org-awake" } });
    expect((await load(g.codeRoot)).plugins.awake).toBe("org-awake");
  });

  it("packs is a reviewed key: on a shared store an external config's packs.org is ignored for the checked-in one", async () => {
    const mysql = { store: { type: "mysql", host: "localhost", port: 3306, database: "sf", user: "factory" } };
    const own = temp("sf-packs-own-org-");
    write(join(own, "plugins", "own-awake.plugin.js"), awakePlugin("own-awake"));
    const f = fixture(mysql);
    const external = join(temp("sf-packs-ext-"), "factory.config.json");
    write(external, JSON.stringify({ ...JSON.parse(readFileSync(join(f.codeRoot, "factory.config.json"), "utf8")), packs: { org: own } }));
    const loaded = await loadConfig(f.codeRoot, { configFile: external });
    expect(loaded.packs.map((p) => p.layer)).toEqual(["base"]);
    expect(Object.keys(loaded.registry.awake.plugins)).not.toContain("own-awake");
  });

  it("a pack plugin that claims a default, or a name its kind has, fails startup naming the file", async () => {
    const f = fixture();
    const file = join(f.project, "plugins", "dup.plugin.js");
    write(file, awakePlugin("none"));
    expect((await loadError(f.codeRoot)).message).toContain(file);
    const g = fixture();
    write(join(g.project, "plugins", "default.plugin.js"), `export default { kind: "awake", name: "pack-default", default: true, create: () => ({}) };\n`);
    expect((await loadError(g.codeRoot)).message).toMatch(/pack plugin .*default\.plugin\.js: a pack plugin takes no default/);
  });
});

describe("packs: layers", () => {
  it("with no org path, no .factory/ and no learned folder, prompts, skills and registry equal the base-only result", async () => {
    const f = fixture();
    const loaded = await load(f.codeRoot);
    expect(loaded.packs).toEqual([{ layer: "base", dir: f.codeRoot }]);
    expect(loaded.registry).toBe(REGISTRY);
    expect(loaded.prompts.triage).toBe(BASE_TRIAGE);
    expect(packSkills(loaded.packs)).toEqual([]);
  });

  it("a missing org folder, prompt file or packs key never stops startup: that layer is off", async () => {
    const f = fixture({ packs: { org: join(tmpdir(), "sf-packs-no-such-org") } });
    mkdirSync(f.project);
    const loaded = await load(f.codeRoot);
    expect(loaded.packs.map((p) => p.layer)).toEqual(["base", "project"]);
    expect(loaded.prompts.triage).toBe(BASE_TRIAGE);
  });

  it("packs.order with an unknown layer, a missing layer, base not first or learned not last fails startup, naming the key", async () => {
    const bad = async (order: unknown) => (await loadError(fixture({ packs: { order } }).codeRoot)).message;
    expect(await bad(["base", "org", "project", "learned", "team"])).toContain('packs.order has an unknown layer "team"');
    expect(await bad(["base", "project", "learned"])).toContain('packs.order leaves out the layer "org"');
    expect(await bad(["org", "base", "project", "learned"])).toContain('packs.order must start with "base"');
    expect(await bad(["base", "org", "learned", "project"])).toContain('packs.order must end with "learned"');
    expect(await bad("base")).toContain("packs.order must be a list");
    expect((await loadError(fixture({ packs: { orgs: "x" } }).codeRoot)).message).toContain('unknown config key "orgs" at packs.orgs');
  });

  it("the default order is base, org, project, learned", async () => {
    const org = temp("sf-packs-org-");
    const f = fixture({ packs: { org } });
    mkdirSync(f.project);
    mkdirSync(f.learned, { recursive: true });
    expect((await load(f.codeRoot)).packs.map((p) => p.layer)).toEqual(["base", "org", "project", "learned"]);
  });

  it("the project pack comes from the repo's main checkout: a worktree's copy of .factory/ is ignored", async () => {
    const main = temp("sf-packs-main-");
    git(main, "init", "-q", "-b", "main");
    git(main, "commit", "-q", "--allow-empty", "-m", "init");
    const worktree = join(temp("sf-packs-wt-"), "wt");
    git(main, "worktree", "add", "-q", "-b", "side", worktree);
    expect(mainCheckout(worktree)).toBe(main);
    write(join(main, PROJECT_PACK_DIR, "prompts", "triage.md"), "## Scope\n\nMain checkout scope.\n");
    write(join(worktree, PROJECT_PACK_DIR, "prompts", "triage.md"), "## Scope\n\nWorktree scope.\n");
    const f = fixture({}, worktree);
    const loaded = await load(f.codeRoot);
    expect(loaded.packs).toContainEqual({ layer: "project", dir: join(main, PROJECT_PACK_DIR) });
    expect(loaded.prompts.triage).toContain("Main checkout scope.");
    expect(loaded.prompts.triage).not.toContain("Worktree scope.");
  });

  it("the learned layer is read-only: no code under src/ writes to it", () => {
    const files = readdirSync(join(REPO_ROOT, "src"), { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts"));
    const writers = files.filter((f) => {
      const text = readFileSync(join(REPO_ROOT, "src", f), "utf8");
      return text.includes("LEARNED_PACK_DIR") && /\b(writeFile|mkdir|appendFile|rename|rm|cp)(Sync)?\(/.test(text);
    });
    expect(writers).toEqual([]);
  });

  it("every plugin kind is still there after the packs' plugins join", async () => {
    const f = fixture();
    write(join(f.project, "plugins", "a.plugin.js"), awakePlugin("pack-awake-a"));
    const { registry } = await load(f.codeRoot);
    for (const kind of PLUGIN_KINDS) expect(Object.keys(registry[kind].plugins)).toEqual(expect.arrayContaining(Object.keys(REGISTRY[kind].plugins)));
  });
});
