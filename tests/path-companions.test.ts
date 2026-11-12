import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/compose.js";
import { ConfigKeyError } from "../src/config-keys.js";
import { type PathCompanion, applyCompanions, pathCompanionProblems, pathCompanionsConfig } from "../src/core/companions.js";
import type { FactoryConfig } from "../src/core/config.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { parseTriage } from "../src/core/outputs.js";
import { LiveSettings, baseFromConfig } from "../src/core/settings.js";
import { renderSpec } from "../src/core/spec-comment.js";
import type { RunOutcome, WorkItem } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { FakeAuth, FakeSource, alice, cleanScanner, config, issueRef, silent, triageSpec } from "./helpers/fakes.js";
import { newStore, w1 } from "./helpers/store.js";

// Path companions (design 04-triage.md, issue #224): a change to one path also needs others. The controller
// adds them to a triage answer's allowed_paths before the answer is checked.

const REPO_ROOT = join(import.meta.dirname, "..");
const REAL = JSON.parse(readFileSync(join(REPO_ROOT, "factory.config.json"), "utf8")) as Record<string, unknown>;
const SCHEMA: PathCompanion[] = [
  { when: "src/impl/store/sqlite/schema.ts", also: ["src/impl/store/sql/sql-factory-store.ts", "tests/store-contract.test.ts"] },
];

const answer = (over: Record<string, unknown>) => ({ ...triageSpec, ...over });

describe("applyCompanions", () => {
  it("a `when` match in files_to_change adds each `also` path, naming the `when`", () => {
    const { answer: a, added } = applyCompanions(
      answer({ allowed_paths: ["src/impl/store/sqlite/"], files_to_change: ["src/impl/store/sqlite/schema.ts"] }),
      SCHEMA,
    );
    expect((a as { allowed_paths: string[] }).allowed_paths).toEqual([
      "src/impl/store/sqlite/",
      "src/impl/store/sql/sql-factory-store.ts",
      "tests/store-contract.test.ts",
    ]);
    expect(added).toEqual([
      { path: "src/impl/store/sql/sql-factory-store.ts", because: "src/impl/store/sqlite/schema.ts" },
      { path: "tests/store-contract.test.ts", because: "src/impl/store/sqlite/schema.ts" },
    ]);
  });

  it("matches a path under a `when` folder, and a `when` folder under a named folder", () => {
    const folder: PathCompanion[] = [{ when: "src/x/", also: ["docs/x.md"] }];
    expect(applyCompanions(answer({ allowed_paths: ["src/x/"], files_to_change: ["src/x/a.ts"] }), folder).added).toHaveLength(1);
    expect(applyCompanions(answer({ allowed_paths: ["src/"], files_to_change: ["src/"] }), folder).added).toHaveLength(1);
    expect(applyCompanions(answer({ allowed_paths: ["src/y/"], files_to_change: ["src/y/a.ts"] }), folder).added).toEqual([]);
  });

  it("a `when` named only in allowed_paths adds nothing", () => {
    const a = answer({ allowed_paths: ["src/impl/store/sqlite/schema.ts"], files_to_change: [] });
    expect(applyCompanions(a, SCHEMA).added).toEqual([]);
  });

  it.each([
    ["docs/design.md", "docs/design/"],
    ["docs/plugins.md", "docs/plugins/"],
  ])("an index %s in files_to_change or allowed_paths adds %s and keeps the index", (index, folder) => {
    for (const a of [
      answer({ allowed_paths: [index], files_to_change: [index] }),
      answer({ allowed_paths: ["src/", index], files_to_change: ["src/a.ts"] }),
    ]) {
      const out = applyCompanions(a, []);
      const paths = (out.answer as { allowed_paths: string[] }).allowed_paths;
      expect(paths).toContain(index);
      expect(paths).toContain(folder);
      expect(out.added).toEqual([{ path: folder, because: index }]);
    }
  });

  it("an answer with no `when` path and no index is unchanged, and so is its rendered spec", () => {
    const raw = answer({});
    const out = applyCompanions(raw, SCHEMA);
    expect(out.answer).toBe(raw);
    expect(out.added).toEqual([]);
    const spec = parseTriage(raw);
    const after = parseTriage(out.answer);
    if (!spec.ok || !after.ok) throw new Error("parse");
    expect(renderSpec(after.value, 2, { added: out.added })).toBe(renderSpec(spec.value, 2));
  });

  it("does not add a path an allowed path already covers, nor one twice", () => {
    const both: PathCompanion[] = [...SCHEMA, { when: "src/interfaces/factory-store.ts", also: SCHEMA[0]!.also }];
    const out = applyCompanions(
      answer({
        allowed_paths: ["src/impl/store/", "src/interfaces/", "tests/"],
        files_to_change: ["src/impl/store/sqlite/schema.ts", "src/interfaces/factory-store.ts"],
      }),
      both,
    );
    expect(out.added).toEqual([]);
    const twice = applyCompanions(
      answer({ allowed_paths: ["src/impl/store/sqlite/schema.ts", "src/interfaces/factory-store.ts"], files_to_change: ["src/impl/store/sqlite/schema.ts", "src/interfaces/factory-store.ts"] }),
      both,
    );
    expect(twice.added.map((a) => a.path)).toEqual(["src/impl/store/sql/sql-factory-store.ts", "tests/store-contract.test.ts"]);
  });

  it("a companion path listed only in files_to_change is accepted by parseTriage", () => {
    const raw = answer({
      allowed_paths: ["src/impl/store/sqlite/schema.ts"],
      files_to_change: ["src/impl/store/sqlite/schema.ts", "tests/store-contract.test.ts"],
    });
    expect(parseTriage(raw).ok).toBe(false);
    expect(parseTriage(applyCompanions(raw, SCHEMA).answer).ok).toBe(true);
  });

  it("leaves the phases' allowed_paths alone", () => {
    const phases = [
      { title: "a", problem: "p", done_criteria: ["d"], allowed_paths: ["src/impl/store/sqlite/schema.ts"] },
      { title: "b", problem: "p", done_criteria: ["d"], allowed_paths: ["docs/design.md"] },
    ];
    const out = applyCompanions(answer({ allowed_paths: ["src/impl/store/sqlite/schema.ts"], files_to_change: ["src/impl/store/sqlite/schema.ts"], phases }), SCHEMA);
    expect((out.answer as { phases: unknown }).phases).toEqual(phases);
  });

  it("returns a malformed answer as is", () => {
    for (const bad of [null, "x", { allowed_paths: "src/" , files_to_change: [] }]) {
      expect(applyCompanions(bad, SCHEMA)).toEqual({ answer: bad, added: [] });
    }
  });
});

describe("path_companions load check", () => {
  it.each<[string, unknown, RegExp]>([
    ["not a list", { when: "a", also: ["b"] }, /path_companions must be a list/],
    ["an entry that is not an object", ["a"], /path_companions\[0\] must be an object/],
    ["no when", [{ also: ["b"] }], /path_companions\[0\]\.when/],
    ["an empty when", [{ when: "a", also: ["b"] }, { when: "", also: ["b"] }], /path_companions\[1\]\.when/],
    ["an empty also", [{ when: "a", also: [] }], /path_companions\[0\]\.also/],
    ["no also", [{ when: "a" }], /path_companions\[0\]\.also/],
    ["a non-string also", [{ when: "a", also: [3] }], /path_companions\[0\]\.also/],
    ["an absolute path", [{ when: "/etc/x", also: ["b"] }], /path_companions\[0\]\.when/],
    ["an unknown key", [{ when: "a", also: ["b"], why: "x" }], /path_companions\[0\] has unknown key "why"/],
  ])("rejects %s, naming the key and the entry index", (_, value, message) => {
    const problems = pathCompanionProblems({ path_companions: value });
    expect(problems.join("\n")).toMatch(message);
    expect(() => pathCompanionsConfig({ path_companions: value })).toThrow(message);
  });

  it("an absent key gives no companions", () => {
    expect(pathCompanionProblems({})).toEqual([]);
    expect(pathCompanionsConfig({})).toEqual([]);
  });

  describe("at startup", () => {
    afterEach(() => vi.unstubAllEnvs());
    const root = (cfg: Record<string, unknown>): string => {
      const dir = mkdtempSync(join(tmpdir(), "sf-companions-"));
      mkdirSync(join(dir, "prompts"));
      for (const p of ["triage", "implement", "review"]) writeFileSync(join(dir, "prompts", `${p}.md`), p);
      writeFileSync(join(dir, "factory.config.json"), JSON.stringify(cfg));
      mkdirSync(join(dir, "secrets"));
      writeFileSync(join(dir, "secrets", ".env"), "MYSQL_PASSWORD=pw\nGITHUB_TOKEN=gh\n");
      vi.stubEnv("SOFTWARE_FACTORY_SECRETS_FILE", join(dir, "secrets", ".env"));
      return dir;
    };
    const SQLITE = { ...REAL, store: { type: "sqlite" } };

    it("a bad entry fails loadConfig with the entry index", async () => {
      const err = await loadConfig(root({ ...SQLITE, path_companions: [{ when: "a", also: [] }] })).then(() => null, (e: Error) => e);
      expect(err).toBeInstanceOf(ConfigKeyError);
      expect(err!.message).toContain("path_companions[0].also");
    });

    it("the repo's own entries load", async () => {
      const loaded = await loadConfig(root(SQLITE));
      expect(loaded.config.path_companions).toEqual(expect.arrayContaining([
        { when: "docs/design.md", also: ["docs/design/"] },
        { when: "docs/plugins.md", also: ["docs/plugins/"] },
      ]));
    });

    // Issue #315: the checked-in pairs for the store interface, the config keys and a design topic file.
    const allowedFor = async (file: string): Promise<string[]> => {
      const loaded = await loadConfig(root(SQLITE));
      const out = applyCompanions(answer({ allowed_paths: [file], files_to_change: [file] }), loaded.config.path_companions ?? []);
      return (out.answer as { allowed_paths: string[] }).allowed_paths;
    };

    it("naming the store interface adds the SQL store, the SQLite schema and the contract test", async () => {
      const paths = await allowedFor("src/interfaces/factory-store.ts");
      expect(paths).toEqual(expect.arrayContaining([
        "src/impl/store/sql/sql-factory-store.ts",
        "src/impl/store/sqlite/schema.ts",
        "tests/store-contract.test.ts",
      ]));
      expect(paths.filter((p) => p.includes("mysql"))).toEqual([]);
    });

    it("naming the config keys adds their test; naming a design topic file adds the design index", async () => {
      expect(await allowedFor("src/config-keys.ts")).toContain("tests/config-keys.test.ts");
      expect(await allowedFor("docs/design/04-triage.md")).toContain("docs/design.md");
    });

    it("an absent key loads with no companions", async () => {
      const rest: Record<string, unknown> = { ...SQLITE };
      delete rest.path_companions;
      const loaded = await loadConfig(root(rest));
      expect(loaded.config.path_companions).toEqual([]);
    });
  });
});

describe("the controller's triage branch", () => {
  const DAY = 24 * 60 * 60 * 1000;

  async function setup(over: Partial<FactoryConfig> = {}) {
    const cfg: FactoryConfig = { ...config, path_companions: SCHEMA, ...over };
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const source = new FakeSource();
    const settings = new LiveSettings({ config: cfg, base: baseFromConfig(cfg), source: store });
    const controller = new ControllerRole({ store, source, auth: new FakeAuth(), clock, config: cfg, log: silent, scanner: cleanScanner, settings });
    const intake = async (n: number): Promise<WorkItem> => {
      source.queue.push({ kind: "item_requested", source: issueRef(n), requester: alice, title: "Change", body: "do it" });
      await controller.tickIntake();
      return (await store.getWorkItemBySource("github_issue", issueRef(n).id))!;
    };
    const triage = async (spec: unknown) => {
      clock.advance(DAY);
      const run = await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: 60_000 });
      const outcome: RunOutcome = { status: "succeeded", summary: "s", data: { spec } };
      await store.completeRun(run!.id, run!.lease!.token, outcome);
      await controller.tickRuns();
    };
    const specBody = () => source.comments.find((c) => c.marker.startsWith("<!-- factory:spec:"))?.body ?? "";
    const get = async (it: WorkItem) => (await store.getWorkItem(it.id))!;
    return { intake, triage, specBody, get, store, source, controller };
  }

  it("accepts a companion listed only in files_to_change, stores the added paths and names each in the spec", async () => {
    const f = await setup();
    const it0 = await f.intake(1);
    await f.triage(answer({
      tier: 3,
      allowed_paths: ["src/impl/store/sqlite/schema.ts"],
      files_to_change: ["src/impl/store/sqlite/schema.ts", "src/impl/store/sql/sql-factory-store.ts"],
    }));
    const it1 = await f.get(it0);
    expect(it1).toMatchObject({ stage: "READY", blocked_reason: "spec_pending" });
    expect(it1.allowed_paths).toEqual(["src/impl/store/sqlite/schema.ts", "src/impl/store/sql/sql-factory-store.ts", "tests/store-contract.test.ts"]);
    const body = f.specBody();
    expect(body).toContain("- `src/impl/store/sql/sql-factory-store.ts`: added because the spec names `src/impl/store/sqlite/schema.ts`");
    expect(body).toContain("- `tests/store-contract.test.ts`: added because the spec names `src/impl/store/sqlite/schema.ts`");
  });

  it("an added path under a floor raises the tier", async () => {
    // The test config's floor: src/impl/broker/ is tier 4.
    const f = await setup({ path_companions: [{ when: "docs/a.md", also: ["src/impl/broker/"] }] });
    const it0 = await f.intake(2);
    await f.triage(answer({ tier: 3, allowed_paths: ["docs/a.md"], files_to_change: ["docs/a.md"] }));
    expect((await f.get(it0)).tier).toBe(4);
    expect(f.specBody()).toContain("Tier raised from 3 to 4 because a path is under a floor");
  });

  it("a split spec keeps its phases' allowed_paths; the phase approved by its parent gets the spec line", async () => {
    const f = await setup({ phases_auto_approve: true });
    const phase = (n: number) => ({ title: `Part ${n}`, problem: "p", done_criteria: ["d"], allowed_paths: ["src/impl/store/sqlite/schema.ts"] });
    const parent = await f.intake(3);
    await f.triage(answer({
      estimated_lines: 2600,
      estimated_files: 30,
      allowed_paths: ["src/impl/store/sqlite/schema.ts"],
      files_to_change: ["src/impl/store/sqlite/schema.ts"],
      phases: [phase(1), phase(2)],
    }));
    expect((await f.get(parent)).allowed_paths).toEqual(["src/impl/store/sqlite/schema.ts", "src/impl/store/sql/sql-factory-store.ts", "tests/store-contract.test.ts"]);
    expect(f.specBody()).toContain("#### Phase 1 of 2: Part 1\np\n\nDone when:\n- d\n\nAllowed to change:\n- `src/impl/store/sqlite/schema.ts`\n");
    f.source.queue.push({ kind: "spec_approved", source: issueRef(3), comment_id: "9001", approver: alice });
    await f.controller.tickIntake();
    const p1 = (await f.store.getWorkItemBySource("github_issue", f.source.subIssues[0]!.ref.id))!;

    await f.triage(answer({ allowed_paths: ["docs/design.md"], files_to_change: ["docs/design.md"] }));
    const it1 = await f.get(p1);
    expect(it1).toMatchObject({ stage: "RUNNING" });
    expect(it1.allowed_paths).toEqual(["docs/design.md", "docs/design/"]);
    const spec = f.source.comments.filter((c) => c.source.id === f.source.subIssues[0]!.ref.id && c.marker.startsWith("<!-- factory:spec:")).at(-1)!;
    expect(spec.body).toContain("`phases_auto_approve`");
    expect(spec.body).toContain("- `docs/design/`: added because the spec names `docs/design.md`");
  });
});
