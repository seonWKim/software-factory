import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isCovered, scopeViolations } from "../src/core/policy.js";
import { countDrift, ratchet } from "./architecture/lib.js";

const z = (...paths: string[]) => paths.map((p) => `${p}\0`).join("");

describe("scopeViolations (pure)", () => {
  const allowed = ["src/core/policy.ts", "tests/"];

  it("passes a diff entirely inside allowed_paths", () => {
    expect(scopeViolations(z("src/core/policy.ts", "tests/scope-gate.test.ts", "tests/helpers/x.ts"), allowed)).toEqual([]);
    expect(scopeViolations("", allowed)).toEqual([]);
  });

  it("fails one outside file and names it", () => {
    expect(scopeViolations(z("tests/a.ts", "src/core/worker.ts"), allowed)).toEqual(["src/core/worker.ts"]);
  });

  it("uses the shared coverage rule: no-slash prefixes and sibling directories do not cover", () => {
    expect(isCovered("src/core/outputs.ts", ["src/core"])).toBe(false);
    expect(isCovered("tests2/x.ts", ["tests/"])).toBe(false);
    expect(scopeViolations(z("tests2/x.ts"), allowed)).toEqual(["tests2/x.ts"]);
  });
});

// Migration timestamps (design 04-triage): a build that finds the spec's migration timestamp taken adds the same
// folder, component and slug at a later minute; that file and its test pass the scope check like the spec's path.
describe("scopeViolations and a later same-slug migration", () => {
  const spec = ["src/controller/migrations/20261122T1200-controller-new-thing.migration.ts", "tests/20261122T1200-controller-new-thing.test.ts"];

  it("passes an implement run that adds <later-ts>-<same slug>.migration.ts and its test in place of the spec's paths", () => {
    const later = z("src/controller/migrations/20261122T1202-controller-new-thing.migration.ts", "tests/20261122T1202-controller-new-thing.test.ts");
    expect(scopeViolations(later, spec)).toEqual([]);
  });

  it("still refuses an earlier timestamp, another slug or another component folder", () => {
    const outside = [
      "src/controller/migrations/20261122T1159-controller-new-thing.migration.ts",
      "src/controller/migrations/20261122T1202-controller-other-thing.migration.ts",
      "src/worker/migrations/20261122T1202-worker-new-thing.migration.ts",
      "src/worker/migrations/20261122T1202-controller-new-thing.migration.ts",
      "tests/20261122T1100-controller-new-thing.test.ts",
      "tests/20261122T1202-worker-new-thing.test.ts",
    ];
    expect(scopeViolations(z(...outside), spec)).toEqual([...outside].sort());
  });
});

describe("scopeViolations on real git output", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  function repo() {
    dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "scope-gate-"));
    const env = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: dir,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    };
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8" });
    const write = (p: string, body = p) => {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), body);
    };
    const commit = (msg: string) => {
      git("add", "-A");
      git("commit", "-q", "-m", msg);
    };
    git("init", "-q", "-b", "main");
    write("outside/keep.ts", "export const keep = 1;\n".repeat(20));
    write("outside/gone.ts", "gone\n");
    write("src/in.ts", "in\n");
    commit("base");
    git("checkout", "-q", "-b", "feature");
    const diff = () => git("diff", "--name-only", "-z", "--no-renames", "main...HEAD");
    return { git, write, commit, diff };
  }

  const allowed = ["src/", "tests/"];

  it("passes a diff inside allowed_paths", () => {
    const r = repo();
    r.write("src/in.ts", "changed\n");
    r.write("tests/new.test.ts");
    r.commit("inside");
    expect(scopeViolations(r.diff(), allowed)).toEqual([]);
  });

  it("fails a deleted outside file", () => {
    const r = repo();
    r.git("rm", "-q", "outside/gone.ts");
    r.commit("delete");
    expect(scopeViolations(r.diff(), allowed)).toEqual(["outside/gone.ts"]);
  });

  it("fails a rename whose old path is outside even though the new path is inside", () => {
    const r = repo();
    r.git("mv", "outside/keep.ts", "src/keep.ts");
    r.commit("rename out → in");
    const out = r.diff();
    expect(out.split("\0").filter(Boolean).sort()).toEqual(["outside/keep.ts", "src/keep.ts"]);
    expect(scopeViolations(out, allowed)).toEqual(["outside/keep.ts"]);
  });

  it("passes a rename with both paths inside", () => {
    const r = repo();
    r.git("mv", "src/in.ts", "src/moved.ts");
    r.commit("rename in → in");
    expect(scopeViolations(r.diff(), allowed)).toEqual([]);
  });

  it("checks the cumulative branch diff, not only the newest commit", () => {
    const r = repo();
    r.write("outside/keep.ts", "sneaky\n");
    r.commit("first run: outside change");
    r.write("src/in.ts", "fix\n");
    r.commit("second run: inside change");
    expect(scopeViolations(r.diff(), allowed)).toEqual(["outside/keep.ts"]);
  });

  it("does not fail a branch that merged base in for files only base changed", () => {
    const r = repo();
    r.write("src/in.ts", "feature\n");
    r.commit("feature work");
    r.git("checkout", "-q", "main");
    r.write("outside/base-only.ts");
    r.write("outside/keep.ts", "base changed this\n");
    r.commit("base moves on");
    r.git("checkout", "-q", "feature");
    r.git("merge", "-q", "--no-edit", "main");
    expect(scopeViolations(r.diff(), allowed)).toEqual([]);
    // A merge commit does not hide the branch's own outside change either.
    r.write("outside/gone.ts", "agent change\n");
    r.commit("outside after merge");
    expect(scopeViolations(r.diff(), allowed)).toEqual(["outside/gone.ts"]);
  });
});

// Ratchet lists (design 04-triage, decided 2026-11-16): tests/architecture/known-violations/ is always writable,
// so a run that shrinks a list never stops for a path; the architecture tests still refuse any growth.
describe("ratchet lists under tests/architecture/known-violations/", () => {
  const KNOWN = "tests/architecture/known-violations/";
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  /** A repo whose base has a count budget and a name list, and a feature branch that shrinks both. */
  function shrink(files: Record<string, unknown>): string {
    dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "scope-ratchet-"));
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8" });
    const write = (p: string, body: unknown) => {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), JSON.stringify(body, null, 2) + "\n");
    };
    git("init", "-q", "-b", "main");
    write(`${KNOWN}file-budget.json`, { "compose.ts": 1330, "core/types.ts": 734 });
    write(`${KNOWN}dependency-direction.json`, { "component-imports-legacy": 305, "other-rule": 2 });
    write(`${KNOWN}unit-purity.json`, ["reaches-io|a.unit.ts|x", "reaches-io|b.unit.ts|y"]);
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    git("checkout", "-q", "-b", "feature");
    for (const [p, body] of Object.entries(files)) write(p, body);
    git("add", "-A");
    git("commit", "-q", "-m", "shrink");
    return git("diff", "--name-only", "-z", "--no-renames", "main...HEAD");
  }

  it("passes a diff that lowers a count in file-budget.json when allowed_paths does not name it", () => {
    const diff = shrink({ [`${KNOWN}file-budget.json`]: { "compose.ts": 1290, "core/types.ts": 734 } });
    expect(diff).toContain("file-budget.json");
    expect(scopeViolations(diff, ["src/"])).toEqual([]);
  });

  it("passes a diff that removes an entry from dependency-direction.json or a name list when allowed_paths does not name it", () => {
    const diff = shrink({
      [`${KNOWN}dependency-direction.json`]: { "component-imports-legacy": 305 },
      [`${KNOWN}unit-purity.json`]: ["reaches-io|a.unit.ts|x"],
    });
    expect(diff.split("\0").filter(Boolean).sort()).toEqual([`${KNOWN}dependency-direction.json`, `${KNOWN}unit-purity.json`]);
    expect(scopeViolations(diff, [])).toEqual([]);
  });

  it("still fails any other file in the same diff", () => {
    const diff = shrink({ [`${KNOWN}file-budget.json`]: { "compose.ts": 1 }, "tests/architecture/lib.json": {} });
    expect(scopeViolations(diff, ["src/"])).toEqual(["tests/architecture/lib.json"]);
  });
});

// The growth checks themselves are unchanged (tests/architecture/lib.ts); this shows they still refuse growth
// against the checked-in lists. SF_RATCHET_UPDATE=1 makes them rewrite the lists, so they are skipped then.
describe.skipIf(process.env.SF_RATCHET_UPDATE === "1")("the architecture ratchet still refuses growth", () => {
  const known = <T>(name: string): T =>
    JSON.parse(readFileSync(join(import.meta.dirname, "architecture", "known-violations", `${name}.json`), "utf8")) as T;

  it("a count above its budget, or a budget raised above the count, fails file-budget", () => {
    const budget = known<Record<string, number>>("file-budget");
    const [file, n] = Object.entries(budget)[0]!;
    expect(countDrift("file-budget", { ...budget, [file]: n + 1 }).grew).toEqual([`${file}: ${n} → ${n + 1}`]);
    // Raising the JSON's count above the code's is the same drift seen from the list: the list no longer matches.
    expect(countDrift("file-budget", { ...budget, [file]: n - 1 }).fell_but_list_not_lowered).toEqual([`${file}: ${n} → ${n - 1}`]);
    expect(countDrift("file-budget", budget)).toEqual({ grew: [], fell_but_list_not_lowered: [] });
  });

  it("a name added to a name list, or a new violation, fails the ratchet", () => {
    const names = known<string[]>("unit-purity");
    expect(() => ratchet("unit-purity", names)).not.toThrow();
    // A name in the list that the code does not have (the list grew) fails, and so does a new violation.
    // An empty env keeps SF_RATCHET_SHRINK and SF_RATCHET_UPDATE off, so made-up names never write the list.
    expect(() => ratchet("unit-purity", names.slice(1), { env: {} })).toThrow();
    expect(() => ratchet("unit-purity", [...names, "reaches-io|new.unit.ts|z"], { env: {} })).toThrow();
  });
});
