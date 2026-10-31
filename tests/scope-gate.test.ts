import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isCovered, scopeViolations } from "../src/core/policy.js";

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
