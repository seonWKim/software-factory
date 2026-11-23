import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadCommands } from "../src/cli/index.js";
import type { UserId } from "../src/core/types.js";
import { AgentsHomeEvalSource, evalSourceHome, skillTag } from "../src/impl/eval-source/agents-home-eval-source.js";
import type { ScanResult } from "../src/interfaces/egress-scanner.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import type { Loaded } from "../src/load-config.js";
import { REGISTRY, createPlugin, selectPlugins } from "../src/plugins.js";
import { importSkillEvalCases } from "../src/runtime/skill-evals/import.js";
import { skillEvalAuthoring } from "../src/skill-evals.js";
import { newStore } from "./helpers/store.js";

// `factory eval import <skill> [--source <plugin>]` (design 06-measurement) over a test store, the real registry's
// SkillEvalSource plugins, a temporary AGENTS_HOME holding a fake `bin/golden`, and a fake egress scanner.

const OWNER = "local:owner" as UserId;
const SKILL = "skills/tests-first";
const ENV = async () => ({ gitEmail: "owner@example.com", osUser: null });
const BASE = { loaded: {} as Loaded, repo: { owner: "o", name: "n" }, extraScanValues: [] };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** A fake `golden` that answers only the two `show` forms the source runs, from files in its home. */
const GOLDEN = `#!/bin/sh
[ "$1" = show ] || exit 2
if [ "$2" = --status ]; then
  [ "$3" = active ] && [ "$4" = --tags ] && [ "$5" = tests-first ] && [ $# -eq 5 ] || exit 3
  cat "$AGENTS_HOME/list.jsonl"
  exit 0
fi
[ $# -eq 2 ] && cat "$AGENTS_HOME/cases/$2.json"
`;

interface SourceCase { id: string; input: unknown; expected: unknown }

/** A temporary agents home whose golden lists `cases` as active. */
function agentsHome(cases: readonly SourceCase[], opts: { cli?: boolean } = {}): string {
  const home = mkdtempSync(join(tmpdir(), "sf-agents-home-"));
  writeCases(home, cases);
  if (opts.cli !== false) {
    mkdirSync(join(home, "bin"));
    writeFileSync(join(home, "bin", "golden"), GOLDEN);
    chmodSync(join(home, "bin", "golden"), 0o755);
  }
  return home;
}

function writeCases(home: string, cases: readonly SourceCase[]): void {
  mkdirSync(join(home, "cases"), { recursive: true });
  writeFileSync(join(home, "list.jsonl"), cases.map((c) => JSON.stringify({ id: c.id, status: "active", tags: ["tests-first"] })).join("\n") + "\n");
  for (const c of cases) writeFileSync(join(home, "cases", `${c.id}.json`), JSON.stringify({ id: c.id, status: "active", body: { input: c.input, expected: c.expected } }, null, 1));
}

/** Every path under `dir` with its size and mtime: what "writes nothing" compares. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    const p = join(e.parentPath, e.name);
    const s = statSync(p);
    out[p] = `${s.size}:${s.mtimeMs}`;
  }
  return out;
}

/** A fake scanner: flags any text holding "SECRET" under the rule `fake_token`. */
const scanner = { scan: vi.fn(async (_c: string, text: string): Promise<ScanResult> => (text.includes("SECRET") ? { clean: false, findings: [{ rule: "fake_token", channel: "log" }] } : { clean: true })) };

/** The CLI's importCases as main.ts wires it, over the real registry, `selected` and the fake scanner. */
function importCases(selected: string | undefined): NonNullable<typeof skillEvalAuthoring.importCases> {
  return (store, r) => importSkillEvalCases({
    store, selected, registered: Object.keys(REGISTRY.eval_source.plugins), open: (name) => createPlugin(REGISTRY, "eval_source", name, BASE), scanner: async () => scanner,
  }, r);
}

/** Runs the real `eval` command over `store` (kept open after it). */
/** `selected`: plugins.eval_source, null when config leaves it out. */
async function evalCommand(store: FactoryStore, args: string[], selected: string | null = "agents-home") {
  const dir = mkdtempSync(join(tmpdir(), "sf-eval-import-"));
  const loaded = { root: dir, stateDir: dir, file: {}, config: {} } as unknown as Loaded;
  const kept = new Proxy(store, { get: (t, k) => (k === "close" ? async () => {} : Reflect.get(t, k, t)) });
  const out: string[] = [], err: string[] = [];
  vi.spyOn(console, "log").mockImplementation((s: string) => void out.push(s));
  vi.spyOn(console, "error").mockImplementation((s: string) => void err.push(s));
  const authoring = { ...skillEvalAuthoring, importCases: importCases(selected ?? undefined) };
  const code = await (await loadCommands()).get("eval")!.run(args, { name: "eval", authoring, usage: "", load: async () => loaded, environment: ENV, openStore: async () => kept });
  vi.spyOn(console, "log").mockRestore();
  vi.spyOn(console, "error").mockRestore();
  return { code, out: out.join("\n"), err: err.join("\n") };
}

async function storeWithSuite() {
  const { store } = await newStore();
  await store.createSkillEvalSuite({ id: "s1", skill_ref: SKILL, title: "t", created_by: OWNER });
  return store;
}

const cases = (store: FactoryStore) => store.listSkillEvalCases("s1");
const G1 = { id: "G-1", input: { trigger: "write the test first" }, expected: ["writes a failing test before code"] };
const G2 = { id: "G-2", input: { trigger: "fix the bug" }, expected: ["adds a regression test"] };

describe("plugins.eval_source", () => {
  it("registers SkillEvalSource with none and agents-home at plugins.eval_source", () => {
    expect(REGISTRY.eval_source.interface).toBe("SkillEvalSource");
    expect(REGISTRY.eval_source.configKey).toBe("plugins.eval_source");
    expect(Object.keys(REGISTRY.eval_source.plugins)).toEqual(expect.arrayContaining(["none", "agents-home"]));
  });

  it("selects none or agents-home; left out selects no source; any other name fails, naming the key", () => {
    const sel = (eval_source?: unknown) => selectPlugins(REGISTRY, { store: { type: "sqlite" }, plugins: { secrets: "env-file", egress: "pattern", broker: "github", ...(eval_source === undefined ? {} : { eval_source }) } });
    expect(sel("none").eval_source).toBe("none");
    expect(sel("agents-home").eval_source).toBe("agents-home");
    expect(sel().eval_source).toBeUndefined();
    expect(() => sel("golden")).toThrow(/plugins\.eval_source/);
  });
});

describe("factory eval import: no source", () => {
  it("with no source selected, or --source none, says no source is on, exits 1 and writes no case", async () => {
    const store = await storeWithSuite();
    for (const [args, selected] of [[["import", SKILL], null], [["import", SKILL], "none"], [["import", SKILL, "--source", "none"], "agents-home"]] as const) {
      const r = await evalCommand(store, [...args], selected);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/no eval source is on/);
    }
    expect(await cases(store)).toEqual([]);
  });

  it("refuses a --source that is not registered, exits 1 and writes nothing", async () => {
    vi.stubEnv("AGENTS_HOME", agentsHome([G1]));
    const store = await storeWithSuite();
    const r = await evalCommand(store, ["import", SKILL, "--source", "golden"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/unknown eval source "golden"/);
    expect(await cases(store)).toEqual([]);
  });

  it("refuses with no suite for the skill, as case add does", async () => {
    vi.stubEnv("AGENTS_HOME", agentsHome([G1]));
    const { store } = await newStore();
    const r = await evalCommand(store, ["import", SKILL]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`no skill eval suite for ${SKILL}`);
  });
});

describe("factory eval import: agents-home", () => {
  it("stores each case as a local copy with id import:<source>:<skill>:<source case id>, writing nothing under the home", async () => {
    const home = agentsHome([G1, G2]);
    vi.stubEnv("AGENTS_HOME", home);
    const before = tree(home);
    const store = await storeWithSuite();
    const r = await evalCommand(store, ["import", SKILL]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`imported case import:agents-home:${SKILL}:G-1`);
    expect(await cases(store)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: `import:agents-home:${SKILL}:G-1`, suite_id: "s1", input: G1.input, expected: G1.expected }),
      expect.objectContaining({ id: `import:agents-home:${SKILL}:G-2`, suite_id: "s1", input: G2.input, expected: G2.expected }),
    ]));
    expect(tree(home)).toEqual(before);
  });

  it("uses the --source plugin over the configured one", async () => {
    vi.stubEnv("AGENTS_HOME", agentsHome([G1]));
    const store = await storeWithSuite();
    expect((await evalCommand(store, ["import", SKILL, "--source", "agents-home"], null)).code).toBe(0);
    expect((await cases(store)).map((c) => c.id)).toContain(`import:agents-home:${SKILL}:G-1`);
  });

  it("a re-import stores only new ids; a stored case keeps its input and expected", async () => {
    const home = agentsHome([G1]);
    vi.stubEnv("AGENTS_HOME", home);
    const store = await storeWithSuite();
    await evalCommand(store, ["import", SKILL]);
    writeCases(home, [{ ...G1, input: { trigger: "changed at the source" } }, G2]);
    const r = await evalCommand(store, ["import", SKILL]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`imported case import:agents-home:${SKILL}:G-2`);
    expect(r.out).not.toContain(`imported case import:agents-home:${SKILL}:G-1`);
    expect(r.out).toMatch(/1 case already stored/);
    expect(await store.getSkillEvalCase(`import:agents-home:${SKILL}:G-1`)).toEqual(expect.objectContaining({ input: G1.input, expected: G1.expected }));
  });

  it("an edit of an imported case stays local: nothing is written to the source", async () => {
    const home = agentsHome([G1]);
    vi.stubEnv("AGENTS_HOME", home);
    const store = await storeWithSuite();
    await evalCommand(store, ["import", SKILL]);
    const before = tree(home);
    const id = `import:agents-home:${SKILL}:G-1`;
    const r = await evalCommand(store, ["case", "edit", id, "--input", "edited here"]);
    expect(r.code).toBe(0);
    expect(await store.getSkillEvalCase(id)).toEqual(expect.objectContaining({ input: "edited here" }));
    expect(tree(home)).toEqual(before);
  });

  it("scans input and expected before storing: a finding stores nothing and names the rule, never the text", async () => {
    vi.stubEnv("AGENTS_HOME", agentsHome([G1, { id: "G-3", input: { trigger: "token SECRET-abc123" }, expected: ["ok"] }]));
    const store = await storeWithSuite();
    const r = await evalCommand(store, ["import", SKILL]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("case G-3: egress findings fake_token");
    expect(r.err).toContain("nothing written");
    expect(r.err + r.out).not.toContain("SECRET");
    expect(await cases(store)).toEqual([]);
  });

  it("checks each case as case add does: a case whose expected is not check texts stores nothing", async () => {
    vi.stubEnv("AGENTS_HOME", agentsHome([G1, { id: "G-4", input: { trigger: "x" }, expected: "not a list" }]));
    const store = await storeWithSuite();
    const r = await evalCommand(store, ["import", SKILL]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/case G-4: expected must be a list of rubric check texts/);
    expect(await cases(store)).toEqual([]);
  });

  it("a missing agents home or golden CLI refuses (exit 1, nothing written); the plugin still builds", async () => {
    const store = await storeWithSuite();
    for (const home of [join(tmpdir(), "sf-no-such-agents-home"), agentsHome([G1], { cli: false })]) {
      vi.stubEnv("AGENTS_HOME", home);
      await expect(createPlugin(REGISTRY, "eval_source", "agents-home", BASE)).resolves.toBeDefined();
      const r = await evalCommand(store, ["import", SKILL]);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/eval source agents-home cannot be read: no executable bin\/golden/);
    }
    expect(await cases(store)).toEqual([]);
  });

  it("a golden that fails refuses, naming the call", async () => {
    const home = agentsHome([G1]);
    rmSync(join(home, "list.jsonl"));
    writeFileSync(join(home, "bin", "golden"), "#!/bin/sh\nexit 4\n");
    const source = new AgentsHomeEvalSource({ AGENTS_HOME: home });
    await expect(source.listCases(SKILL)).rejects.toThrow(/golden show failed \(exit 4\)/);
  });
});

describe("agents-home: where it reads", () => {
  it("reads AGENTS_HOME, else ~/.agents", () => {
    expect(evalSourceHome({ AGENTS_HOME: "/x/home" }, "/u")).toBe("/x/home");
    expect(evalSourceHome({ AGENTS_HOME: "  " }, "/u")).toBe(join("/u", ".agents"));
    expect(evalSourceHome({}, "/u")).toBe(join("/u", ".agents"));
    expect(new AgentsHomeEvalSource({}, "/u").home).toBe(join("/u", ".agents"));
  });

  it("tags a skill by its last path segment; refuses an empty one or one with a comma", () => {
    expect(skillTag("skills/tests-first")).toBe("tests-first");
    expect(skillTag("tests-first/")).toBe("tests-first");
    expect(skillTag("skills/a,b")).toBeNull();
    expect(skillTag("/")).toBeNull();
  });
});
