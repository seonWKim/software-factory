import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/load-config.js";
import { COMPANION_RULES, type PathCompanion, applyCompanions, companionNote, pathCompanionProblems, pathCompanionsConfig, refusedCompanion } from "../src/core/companions.js";
import { GATE_PATHS } from "../src/core/improver.js";
import type { Floor } from "../src/core/settings.js";
import { PROTECTED_PATHS } from "../src/core/standing.js";
import type { FactoryConfig } from "../src/core/config.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { MAX_APPLIED_DEFAULTS, parseTriage } from "../src/core/outputs.js";
import { LiveSettings, baseFromConfig } from "../src/core/settings.js";
import { renderSpec } from "../src/core/spec-comment.js";
import type { RunOutcome, WorkItem } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { FakeAuth } from "./helpers/fakes/runner.js";
import { FakeSource } from "./helpers/fakes/source.js";
import { alice, cleanScanner, config, issueRef, silent, triageSpec } from "./helpers/fakes/config.js";
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
      [],
    );
    // Config entries come first; the built-in rules' paths (design 04-triage.md) follow them.
    expect((a as { allowed_paths: string[] }).allowed_paths.slice(0, 3)).toEqual([
      "src/impl/store/sqlite/",
      "src/impl/store/sql/sql-factory-store.ts",
      "tests/store-contract.test.ts",
    ]);
    expect(added.slice(0, 2)).toEqual([
      { path: "src/impl/store/sql/sql-factory-store.ts", because: "src/impl/store/sqlite/schema.ts" },
      { path: "tests/store-contract.test.ts", because: "src/impl/store/sqlite/schema.ts" },
    ]);
  });

  it("matches a path under a `when` folder, and a `when` folder under a named folder", () => {
    const folder: PathCompanion[] = [{ when: "src/x/", also: ["docs/x.md"] }];
    const paths = (allowed: string, file: string) => applyCompanions(answer({ allowed_paths: [allowed], files_to_change: [file] }), folder, []).added.map((a) => a.path);
    expect(paths("src/x/", "src/x/a.ts")).toContain("docs/x.md");
    expect(paths("src/", "src/")).toEqual(["docs/x.md"]);
    expect(paths("src/y/", "src/y/a.ts")).not.toContain("docs/x.md");
  });

  it("a `when` named only in allowed_paths adds nothing", () => {
    const a = answer({ allowed_paths: ["src/impl/store/sqlite/schema.ts"], files_to_change: [] });
    expect(applyCompanions(a, SCHEMA, []).added).toEqual([]);
  });

  it.each([
    ["docs/design.md", "docs/design/"],
    ["docs/plugins.md", "docs/plugins/"],
  ])("an index %s in files_to_change or allowed_paths adds %s and keeps the index", (index, folder) => {
    for (const a of [
      answer({ allowed_paths: [index], files_to_change: [index] }),
      answer({ allowed_paths: ["src/", index], files_to_change: ["src/a.ts"] }),
    ]) {
      const out = applyCompanions(a, [], []);
      const paths = (out.answer as { allowed_paths: string[] }).allowed_paths;
      expect(paths).toContain(index);
      expect(paths).toContain(folder);
      expect(out.added.filter((x) => x.because === index)).toEqual([{ path: folder, because: index }]);
    }
  });

  it("an answer with no `when` path and no index is unchanged, and so is its rendered spec", () => {
    const raw = answer({});
    const out = applyCompanions(raw, SCHEMA, []);
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
      [],
    );
    expect(out.added).toEqual([]);
    const twice = applyCompanions(
      answer({ allowed_paths: ["src/impl/store/sqlite/schema.ts", "src/interfaces/factory-store.ts"], files_to_change: ["src/impl/store/sqlite/schema.ts", "src/interfaces/factory-store.ts"] }),
      both,
      [],
    );
    expect(twice.added.map((a) => a.path).slice(0, 2)).toEqual(["src/impl/store/sql/sql-factory-store.ts", "tests/store-contract.test.ts"]);
    expect(twice.added.filter((a) => a.path === "tests/store-contract.test.ts")).toHaveLength(1);
  });

  it("a companion path listed only in files_to_change is accepted by parseTriage", () => {
    const raw = answer({
      allowed_paths: ["src/impl/store/sqlite/schema.ts"],
      files_to_change: ["src/impl/store/sqlite/schema.ts", "tests/store-contract.test.ts"],
    });
    expect(parseTriage(raw).ok).toBe(false);
    expect(parseTriage(applyCompanions(raw, SCHEMA, []).answer).ok).toBe(true);
  });

  it("leaves the phases' allowed_paths alone", () => {
    const phases = [
      { title: "a", problem: "p", done_criteria: ["d"], allowed_paths: ["src/impl/store/sqlite/schema.ts"] },
      { title: "b", problem: "p", done_criteria: ["d"], allowed_paths: ["docs/design.md"] },
    ];
    const out = applyCompanions(answer({ allowed_paths: ["src/impl/store/sqlite/schema.ts"], files_to_change: ["src/impl/store/sqlite/schema.ts"], phases }), SCHEMA, []);
    expect((out.answer as { phases: unknown }).phases).toEqual(phases);
  });

  it("returns a malformed answer as is", () => {
    for (const bad of [null, "x", { allowed_paths: "src/" , files_to_change: [] }]) {
      expect(applyCompanions(bad, SCHEMA, [])).toEqual({ answer: bad, added: [] });
    }
  });
});

// Built-in rules (decided 2026-11-18): a file's companions read from its path alone, since triage has no clone.
// Decided 2026-11-22 (wi_3f9ab60a): an entry may say why (`reason`, noted in the spec's applied defaults) and may
// need more named paths (`with`), so a rule fires only on the change it is for.
describe("companion rule reasons and `with`", () => {
  const STORE: PathCompanion = { when: "src/store.ts", also: ["src/store/"], reason: "the store is at its line budget" };
  const out = (files: string[], companions: PathCompanion[], over: Record<string, unknown> = {}) => {
    const r = applyCompanions(answer({ allowed_paths: files, files_to_change: files, ...over }), companions, []);
    return { ...(r.answer as { allowed_paths: string[]; applied_defaults?: string[] }), added: r.added };
  };

  it("a matching rule adds its paths and notes its reason under the applied defaults, after triage's own", () => {
    const a = out(["src/store.ts"], [STORE], { applied_defaults: ["Owner default: keep the CLI flag."] });
    expect(a.allowed_paths).toContain("src/store/");
    expect(a.applied_defaults).toEqual(["Owner default: keep the CLI flag.", "Added by companion rule: the store is at its line budget"]);
    expect(parseTriage(a).ok).toBe(true);
  });

  it("a rule that does not match adds no path and no note", () => {
    const a = out(["src/other.ts"], [STORE]);
    expect(a.allowed_paths).not.toContain("src/store/");
    expect(a.applied_defaults).toBeUndefined();
  });

  it("a rule whose paths are already allowed adds no note", () => {
    expect(out(["src/store.ts", "src/store/"], [STORE]).applied_defaults).toBeUndefined();
  });

  it("a rule with no reason adds its paths and no note", () => {
    const a = out(["src/store.ts"], [{ when: "src/store.ts", also: ["src/store/"] }]);
    expect(a.allowed_paths).toContain("src/store/");
    expect(a.applied_defaults).toBeUndefined();
  });

  it("two rules with the same reason give one note", () => {
    const twin: PathCompanion = { when: "src/store.ts", also: ["docs/store.md"], reason: STORE.reason! };
    expect(out(["src/store.ts"], [STORE, twin]).applied_defaults?.filter((d) => d.startsWith("Added by companion rule"))).toHaveLength(1);
  });

  it("notes that would pass the applied-defaults limit share one line; with no room left none is added", () => {
    const rules: PathCompanion[] = [STORE, { when: "src/store.ts", also: ["docs/x.md"], reason: "x" }];
    const nine = Array.from({ length: MAX_APPLIED_DEFAULTS - 1 }, (_, i) => `d${i}`);
    expect(out(["src/store.ts"], rules, { applied_defaults: nine }).applied_defaults).toEqual([...nine, companionNote("the store is at its line budget; x")]);
    const full = Array.from({ length: MAX_APPLIED_DEFAULTS }, (_, i) => `d${i}`);
    const a = out(["src/store.ts"], rules, { applied_defaults: full });
    expect(a.applied_defaults).toEqual(full);
    expect(a.allowed_paths).toContain("src/store/");
    expect(parseTriage(a).ok).toBe(true);
  });

  it("a rule with `with` applies only when files_to_change names every `with` path too", () => {
    const kind: PathCompanion = { when: "lib/types.ts", with: ["lib/runs/"], also: ["lib/kinds.ts"], reason: "a new run kind" };
    expect(out(["lib/types.ts"], [kind]).added).toEqual([]);
    expect(out(["lib/runs/a/a.run.ts"], [kind]).added).toEqual([]);
    const both = out(["lib/types.ts", "lib/runs/a/a.run.ts"], [kind]);
    expect(both.added).toEqual([{ path: "lib/kinds.ts", because: "lib/types.ts" }]);
    expect(both.applied_defaults).toContain("Added by companion rule: a new run kind");
  });
});

describe("built-in companion rules", () => {
  const allowedAfter = (files: string[], floors: Floor[] = []) => {
    const out = applyCompanions(answer({ allowed_paths: files, files_to_change: files }), [], floors);
    return { paths: (out.answer as { allowed_paths: string[] }).allowed_paths, added: out.added };
  };

  it("a design topic file adds its History file, naming the topic", () => {
    const { paths, added } = allowedAfter(["docs/design/04-triage.md"]);
    expect(paths).toContain("docs/design/history/04-triage.md");
    expect(added).toContainEqual({ path: "docs/design/history/04-triage.md", because: "docs/design/04-triage.md" });
    expect(allowedAfter(["docs/design/history/04-triage.md"]).added).toEqual([]);
    expect(allowedAfter(["docs/plugins/forge.md"]).added).toEqual([]);
  });

  it.each([
    ["web/src/views/tasks.tsx", "web/src/i18n/en/tasks.ts"],
    ["web/src/views/settings-calendar.tsx", "web/src/i18n/en/settings.ts"],
    ["web/src/views/settings/editor.tsx", "web/src/i18n/en/settings.ts"],
    ["web/src/components/rules.tsx", "web/src/i18n/en/rules.ts"],
  ])("a web view or component %s whose area file exists adds only its i18n area file %s, not the barrel", (file, area) => {
    const { paths, added } = allowedAfter([file]);
    expect(paths).toContain(area);
    expect(added).toContainEqual({ path: area, because: file });
    expect(paths).not.toContain("web/src/i18n/en.ts");
    expect(added.map((a) => a.path)).not.toContain("web/src/i18n/en.ts");
  });

  it("a new area file named by triage also adds the generated barrel the answer names", () => {
    const view = "web/src/views/quotas.tsx";
    const out = applyCompanions(
      answer({ allowed_paths: [view, "web/src/i18n/en/quotas.ts"], files_to_change: [view, "web/src/i18n/en/quotas.ts", "web/src/i18n/en.ts"] }),
      [],
      [],
    );
    const paths = (out.answer as { allowed_paths: string[] }).allowed_paths;
    expect(paths).toContain("web/src/i18n/en/quotas.ts");
    expect(paths).toContain("web/src/i18n/en.ts");
    expect(out.added).toContainEqual({ path: "web/src/i18n/en.ts", because: "web/src/i18n/en.ts" });
  });

  it("a plan for one page's text names neither the design index nor the barrel", () => {
    const { paths } = allowedAfter(["web/src/views/tasks.tsx", "web/src/i18n/en/tasks.ts"]);
    expect(paths).not.toContain("docs/design.md");
    expect(paths).not.toContain("web/src/i18n/en.ts");
  });

  it("a web file that names no area adds neither an area file nor the barrel", () => {
    for (const file of ["web/src/App.tsx", "web/src/components/ui/button.tsx", "web/src/api.ts"]) {
      expect(allowedAfter([file]).added.filter((a) => a.path.startsWith("web/src/i18n/"))).toEqual([]);
    }
  });

  it.each([
    ["src/core/hotspots.ts", "tests/hotspots.test.ts"],
    ["src/migrate-drain.ts", "tests/migrate-drain.test.ts"],
    ["src/cli/handlers/plugins/plugins.command.ts", "tests/plugins.test.ts"],
    ["src/ui/page.tsx", "tests/page.test.tsx"],
  ])("a source file %s adds its covering test %s by name", (file, test) => {
    const { paths, added } = allowedAfter([file]);
    expect(paths).toContain(test);
    expect(added).toContainEqual({ path: test, because: file });
  });

  it("a test, a doc or a non-source file adds no test", () => {
    for (const file of ["tests/hotspots.test.ts", "docs/setup.md", "schema/sqlite/bus.sql", "src/types.d.ts", "src/index.ts", "web/src/views/data.tsx", "scripts/x.ts"]) {
      expect(allowedAfter([file]).added.filter((a) => a.path.startsWith("tests/"))).toEqual([]);
    }
  });

  it("a migration under src/<owner>/migrations/ adds its owner's table-docs file, naming the migration", () => {
    const migration = "src/worker/migrations/20261120T1000-worker-x.migration.ts";
    const { paths, added } = allowedAfter([migration]);
    expect(paths).toContain("src/worker/table-docs.ts");
    expect(added).toContainEqual({ path: "src/worker/table-docs.ts", because: migration });
  });

  it("a controller migration does not add src/controller/table-docs.ts: a gate path is refused, with nothing added in its place", () => {
    const migration = "src/controller/migrations/20261120T1000-x.migration.ts";
    expect(refusedCompanion("src/controller/table-docs.ts", [])).toBe(true);
    const { paths, added } = allowedAfter([migration]);
    expect(paths).not.toContain("src/controller/table-docs.ts");
    expect(added.filter((a) => a.path.includes("table-docs"))).toEqual([]);
    // Only the covering-test rule's and the schema snapshot rule's paths are added for it.
    expect(added.filter((a) => a.because === migration)).toEqual([
      { path: "tests/20261120T1000-x.test.ts", because: migration },
      { path: "schema/sqlite/controller.sql", because: migration },
    ]);
  });

  it("the migrations folder itself, named for a new migration, adds its owner's table-docs file", () => {
    expect(allowedAfter(["src/worker/migrations/"]).added).toContainEqual({ path: "src/worker/table-docs.ts", because: "src/worker/migrations/" });
  });

  it("a file that is not a .ts file directly under src/<owner>/migrations/ adds no table-docs file", () => {
    for (const file of ["src/worker/x.ts", "docs/x.md", "src/worker/migrations/x.sql", "src/worker/migrations/sub/x.ts", "src/migrations/x.ts", "tests/worker/migrations/x.ts"]) {
      expect(allowedAfter([file]).added.filter((a) => a.path.includes("table-docs"))).toEqual([]);
    }
  });

  it("the spec lists a rule-added table-docs file with the migration that caused it", () => {
    const migration = "src/worker/migrations/20261120T1000-worker-x.migration.ts";
    const out = applyCompanions(answer({ allowed_paths: [migration], files_to_change: [migration] }), [], []);
    const spec = parseTriage(out.answer);
    if (!spec.ok) throw new Error("parse");
    expect(renderSpec(spec.value, 2, { added: out.added })).toContain(`- \`src/worker/table-docs.ts\`: added because the spec names \`${migration}\``);
  });

  // Kind rules (wi_06303973): a kind of change named by its file brings fixed files along, noted with the reason.
  const kindNote = (files: string[], reason: string) => {
    const out = applyCompanions(answer({ allowed_paths: files, files_to_change: files }), [], []);
    return ((out.answer as { applied_defaults?: string[] }).applied_defaults ?? []).filter((d) => d === companionNote(reason));
  };

  it.each([
    "src/state/migrations/20261126T1000-state-x.migration.ts",
    "src/controller/migrations/20261126T1000-x.migration.ts",
    "src/worker/migrations/",
  ])("a migration %s adds the schema snapshot, with the reason in the applied defaults", (migration) => {
    const { paths, added } = allowedAfter([migration]);
    expect(paths).toContain("schema/sqlite/controller.sql");
    expect(added).toContainEqual({ path: "schema/sqlite/controller.sql", because: migration });
    expect(kindNote([migration], "a new migration changes the schema snapshot (npm run schema:snapshot)")).toHaveLength(1);
  });

  it.each(["src/api/capabilities/items.ts", "src/api/capabilities/quotas.ts", "src/api/capabilities/"])(
    "a capability %s adds the API registry files, with the reason in the applied defaults",
    (capability) => {
      const { paths, added } = allowedAfter([capability]);
      for (const p of ["src/api/index.ts", "web/src/api/generated.ts", "docs/api/openapi.json"]) {
        expect(paths).toContain(p);
        expect(added).toContainEqual({ path: p, because: capability });
      }
      expect(paths).not.toContain("schema/sqlite/controller.sql");
      expect(kindNote([capability], "a new or changed API capability changes its registry files (npm run gen:api)")).toHaveLength(1);
    },
  );

  it("a capability with a migration also gets the schema snapshot", () => {
    const { paths } = allowedAfter(["src/api/capabilities/quotas.ts", "src/state/migrations/20261126T1000-state-quotas.migration.ts"]);
    expect(paths).toEqual(expect.arrayContaining(["src/api/index.ts", "web/src/api/generated.ts", "docs/api/openapi.json", "schema/sqlite/controller.sql"]));
  });

  it("a file that is neither a migration nor a capability adds no kind-rule file", () => {
    const kind = ["schema/sqlite/controller.sql", "src/api/index.ts", "web/src/api/generated.ts", "docs/api/openapi.json"];
    for (const file of ["src/api/registry.ts", "src/api/capabilities/sub/x.ts", "src/migrations/x.ts", "src/worker/migrations/x.sql", "docs/api/openapi.json"]) {
      expect(allowedAfter([file]).added.filter((a) => kind.includes(a.path))).toEqual([]);
    }
  });

  it("every fixed path a rule names exists in the repository", () => {
    const fixed = COMPANION_RULES.flatMap((r) => r.fixed ?? []);
    expect(fixed).toEqual(expect.arrayContaining(["schema/sqlite/controller.sql", "src/api/index.ts", "web/src/api/generated.ts", "docs/api/openapi.json"]));
    expect(fixed.filter((p) => !existsSync(join(REPO_ROOT, p)))).toEqual([]);
  });

  it("a path already covered is not added again", () => {
    const out = applyCompanions(
      answer({ allowed_paths: ["docs/design/", "tests/"], files_to_change: ["docs/design/04-triage.md", "src/core/hotspots.ts"] }),
      [],
      [],
    );
    expect(out.added).toEqual([]);
  });

  it("refuses every gate path, protected path and floor path a rule could give", () => {
    const protectedPaths = Object.values(PROTECTED_PATHS).flat();
    for (const p of [...GATE_PATHS, ...protectedPaths, "tests/architecture/lib.test.ts", "src/worker/roles/review/golden/1/instruction.md"]) {
      expect(refusedCompanion(p, [])).toBe(true);
    }
    expect(refusedCompanion("tests/hotspots.test.ts", [])).toBe(false);
    expect(refusedCompanion("tests/hotspots.test.ts", [{ prefix: "tests/", tier: 3 }])).toBe(true);
  });

  it("no rule adds a path when its `also` path is under a floor", () => {
    const floors: Floor[] = [
      { prefix: "docs/design/history/", tier: 3 },
      { prefix: "tests/hotspots.test.ts", tier: 4 },
      { prefix: "web/src/i18n/", tier: 3 },
    ];
    const { paths, added } = allowedAfter(["docs/design/04-triage.md", "src/core/hotspots.ts", "web/src/views/tasks.tsx", "src/core/policy.ts"], floors);
    for (const p of ["docs/design/history/04-triage.md", "tests/hotspots.test.ts", "web/src/i18n/en/tasks.ts", "web/src/i18n/en.ts"]) {
      expect(paths).not.toContain(p);
    }
    expect(added.filter((a) => refusedCompanion(a.path, floors))).toEqual([]);
    // A rule's path not under a floor is still added.
    expect(paths).toContain("tests/policy.test.ts");
  });

  it("a config entry is not refused: the refusal is the built-in rules' only", () => {
    const out = applyCompanions(answer({ allowed_paths: ["docs/a.md"], files_to_change: ["docs/a.md"] }), [{ when: "docs/a.md", also: ["prompts/x.md"] }], []);
    expect(out.added).toEqual([{ path: "prompts/x.md", because: "docs/a.md" }]);
  });

  it("each added path is listed in the spec under the path_companions heading with the file that caused it", () => {
    const raw = answer({ allowed_paths: ["docs/design/04-triage.md"], files_to_change: ["docs/design/04-triage.md"] });
    const out = applyCompanions(raw, [], []);
    const spec = parseTriage(out.answer);
    if (!spec.ok) throw new Error("parse");
    const text = renderSpec(spec.value, 2, { added: out.added });
    expect(text).toContain("Added by `path_companions`:");
    expect(text).toContain("- `docs/design/history/04-triage.md`: added because the spec names `docs/design/04-triage.md`");
  });

  it("an answer that matches no rule keeps the same allowed_paths and the same spec text", () => {
    const raw = answer({ allowed_paths: ["README.md"], files_to_change: ["README.md"] });
    const out = applyCompanions(raw, [], []);
    expect(out.answer).toBe(raw);
    expect(out.added).toEqual([]);
    const before = parseTriage(raw), after = parseTriage(out.answer);
    if (!before.ok || !after.ok) throw new Error("parse");
    expect(renderSpec(after.value, 2, { added: out.added })).toBe(renderSpec(before.value, 2));
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
    ["an empty reason", [{ when: "a", also: ["b"], reason: " " }], /path_companions\[0\]\.reason/],
    ["a non-string reason", [{ when: "a", also: ["b"], reason: 3 }], /path_companions\[0\]\.reason/],
    ["an empty with", [{ when: "a", also: ["b"], with: [] }], /path_companions\[0\]\.with/],
    ["an absolute with", [{ when: "a", also: ["b"], with: ["/x"] }], /path_companions\[0\]\.with/],
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

    it("the repo's own entries load", async () => {
      const loaded = await loadConfig(root(SQLITE));
      expect(loaded.config.path_companions).toEqual(expect.arrayContaining([
        expect.objectContaining({ when: "docs/design.md", also: ["docs/design/"] }),
        expect.objectContaining({ when: "docs/plugins.md", also: ["docs/plugins/"] }),
      ]));
      // Every checked-in entry says why, so the spec notes it.
      expect(loaded.config.path_companions!.filter((c) => !c.reason)).toEqual([]);
    });

    // Issue #315: the checked-in pairs for the store interface, the config keys and a design topic file.
    const allowedFor = async (file: string): Promise<string[]> => {
      const loaded = await loadConfig(root(SQLITE));
      const out = applyCompanions(answer({ allowed_paths: [file], files_to_change: [file] }), loaded.config.path_companions ?? [], []);
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

    // Decided 2026-11-16: the generated files a change implies (npm run schema:snapshot, npm run settings:catalog).
    it("naming a migration or the SQLite schema adds schema/sqlite/", async () => {
      expect(await allowedFor("src/controller/migrations/0042-example.ts")).toContain("schema/sqlite/");
      expect(await allowedFor("src/impl/store/sqlite/schema.ts")).toContain("schema/sqlite/");
    });

    it.each([
      "src/controller/settings/",
      "src/guards/settings/",
      "src/inbound/settings/",
      "src/outbound/settings/",
      "src/runtime/settings/",
      "src/state/settings/",
      "src/worker/settings/",
    ])("naming a setting file under %s adds docs/settings.md", async (folder) => {
      expect(await allowedFor(`${folder}example.setting.ts`)).toContain("docs/settings.md");
    });

    // Decided 2026-11-22 (wi_3f9ab60a): the pairs behind most agent_needs_human stops of 2026-11-20..22.
    it("naming a controller migration or the SQLite schema adds src/controller/table-docs.ts", async () => {
      expect(await allowedFor("src/controller/migrations/")).toContain("src/controller/table-docs.ts");
      expect(await allowedFor("src/controller/migrations/20261122T1000-x.migration.ts")).toContain("src/controller/table-docs.ts");
      expect(await allowedFor("src/impl/store/sqlite/schema.ts")).toContain("src/controller/table-docs.ts");
    });

    it("naming the SQL store adds its folder, for the new file its line budget needs", async () => {
      expect(await allowedFor("src/impl/store/sql/sql-factory-store.ts")).toContain("src/impl/store/sql/");
    });

    const KIND_FILES = [
      "src/core/settings.ts",
      "src/worker/settings/worker-kinds.setting.ts",
      "docs/settings.md",
      "tests/settings-catalog.test.ts",
      "tests/worker-kinds.test.ts",
      "tests/architecture/rule-of-two.test.ts",
    ];
    it("a new run kind (the RunKind union and a run folder) adds WORKER_KINDS, the worker_kinds setting, its catalog page, the catalog test and the two tests that pin the kind and role lists", async () => {
      const loaded = await loadConfig(root(SQLITE));
      const files = ["src/core/types.ts", "src/worker/runs/judge/judge.run.ts"];
      const a = applyCompanions(answer({ allowed_paths: files, files_to_change: files }), loaded.config.path_companions ?? [], []).answer as { allowed_paths: string[]; applied_defaults: string[] };
      expect(a.allowed_paths).toEqual(expect.arrayContaining(KIND_FILES));
      expect(a.applied_defaults.some((d) => d.startsWith("Added by companion rule: a new run kind"))).toBe(true);
    });

    it("an edit to one existing run, or to the types alone, adds none of the run-kind files (they are gate paths)", async () => {
      for (const file of ["src/worker/runs/review/review.run.ts", "src/core/types.ts"]) {
        const paths = await allowedFor(file);
        expect(paths.filter((p) => KIND_FILES.includes(p))).toEqual([]);
      }
    });

    it("naming neither adds no generated file", async () => {
      const paths = await allowedFor("src/core/policy.ts");
      expect(paths).not.toContain("schema/sqlite/");
      expect(paths).not.toContain("docs/settings.md");
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
    expect(it1.allowed_paths.slice(0, 3)).toEqual(["src/impl/store/sqlite/schema.ts", "src/impl/store/sql/sql-factory-store.ts", "tests/store-contract.test.ts"]);
    // A built-in rule's path is stored and named in the spec the same way.
    expect(it1.allowed_paths).toContain("tests/schema.test.ts");
    const body = f.specBody();
    expect(body).toContain("- `src/impl/store/sql/sql-factory-store.ts`: added because the spec names `src/impl/store/sqlite/schema.ts`");
    expect(body).toContain("- `tests/store-contract.test.ts`: added because the spec names `src/impl/store/sqlite/schema.ts`");
    expect(body).toContain("- `tests/schema.test.ts`: added because the spec names `src/impl/store/sqlite/schema.ts`");
  });

  it("passes the project's floors, so a rule's path under a floor is refused", async () => {
    const f = await setup({ settings: { ...config.settings, defaults: { ...config.settings.defaults, floors: [{ prefix: "tests/hotspots", tier: 4 }] } } });
    const it0 = await f.intake(4);
    await f.triage(answer({ tier: 3, allowed_paths: ["src/core/hotspots.ts", "src/core/policy.ts"], files_to_change: ["src/core/hotspots.ts", "src/core/policy.ts"] }));
    const it1 = await f.get(it0);
    expect(it1.allowed_paths).not.toContain("tests/hotspots.test.ts");
    expect(it1.allowed_paths).toContain("tests/policy.test.ts");
    expect(it1.tier).toBe(3);
    expect(f.specBody()).not.toContain("`tests/hotspots.test.ts`");
  });

  it("an added path under a floor raises the tier", async () => {
    // The test config's floor: src/impl/broker/ is tier 4.
    const f = await setup({ path_companions: [{ when: "docs/a.md", also: ["src/impl/broker/"] }] });
    const it0 = await f.intake(2);
    await f.triage(answer({ tier: 3, allowed_paths: ["docs/a.md"], files_to_change: ["docs/a.md"] }));
    expect((await f.get(it0)).tier).toBe(4);
    expect(f.specBody()).toContain("Tier raised from 3 to 4 because a path is under a floor");
  });

  it("a /revise reruns triage, and the revised spec gets the companion paths and the reason note too", async () => {
    const f = await setup({ path_companions: [{ when: "src/store.ts", also: ["src/store/"], reason: "the store is at its line budget" }] });
    const it0 = await f.intake(5);
    await f.triage(answer({ tier: 3, allowed_paths: ["src/a.ts"], files_to_change: ["src/a.ts"] }));
    expect((await f.get(it0)).allowed_paths).not.toContain("src/store/");
    f.source.queue.push({ kind: "revise_requested", source: issueRef(5), comment_id: "7001", requester: alice, feedback: "put it in the store" });
    await f.controller.tickIntake();
    expect(await f.get(it0)).toMatchObject({ stage: "NEW", revision_count: 1 });
    await f.triage(answer({ tier: 3, allowed_paths: ["src/store.ts"], files_to_change: ["src/store.ts"] }));
    const it1 = await f.get(it0);
    expect(it1).toMatchObject({ stage: "READY", blocked_reason: "spec_pending" });
    expect(it1.allowed_paths).toContain("src/store/");
    const revised = f.source.comments.filter((c) => c.marker.startsWith("<!-- factory:spec:")).at(-1)!.body;
    expect(revised).toContain("### Applied defaults");
    expect(revised).toContain("- Added by companion rule: the store is at its line budget");
    expect(revised).toContain("- `src/store/`: added because the spec names `src/store.ts`");
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
    expect((await f.get(parent)).allowed_paths.slice(0, 3)).toEqual(["src/impl/store/sqlite/schema.ts", "src/impl/store/sql/sql-factory-store.ts", "tests/store-contract.test.ts"]);
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
