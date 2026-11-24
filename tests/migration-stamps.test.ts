import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { freeMigrationStamps, nextMinute, sameSlugMigrationOf, takenStamps } from "../src/core/migration-stamps.js";
import { NoOpSandbox } from "../src/impl/sandbox/noop-sandbox.js";

// Migration timestamps in a triage answer (design 04-triage): a new migration whose timestamp a base migration uses
// moves to the next free minute, same component and slug, before the spec is shown.

const mig = (stamp: string, component = "controller", slug = "new-thing") => `src/${component}/migrations/${stamp}-${component}-${slug}.migration.ts`;
const test = (stamp: string, component = "controller", slug = "new-thing") => `tests/${stamp}-${component}-${slug}.test.ts`;

const base = takenStamps([
  mig("20261122T1200", "controller", "schedules"),
  mig("20261122T1201", "worker", "cancel-closed-item-runs"),
  mig("20261122T1203", "bus", "topics"),
  "src/controller/units/kernel.ts",
  test("20261122T1200", "controller", "schedules"),
]);

function answer(paths: string[], extra: Record<string, unknown> = {}) {
  return { problem: `Add ${paths[0]}`, allowed_paths: paths, files_to_change: paths, done_checks: [{ line: "x", test_file: paths[1] ?? paths[0] }], ...extra };
}

describe("nextMinute", () => {
  it("adds one minute, carrying over the hour, day, month and year", () => {
    expect(nextMinute("20261122T1200")).toBe("20261122T1201");
    expect(nextMinute("20261122T1259")).toBe("20261122T1300");
    expect(nextMinute("20261130T2359")).toBe("20261201T0000");
    expect(nextMinute("20261231T2359")).toBe("20270101T0000");
  });
});

describe("takenStamps", () => {
  it("reads only migration files in their component folder", () => {
    expect(base.get("20261122T1200")).toBe(mig("20261122T1200", "controller", "schedules"));
    expect(base.has("20261122T1201")).toBe(true);
    expect([...base.values()].every((p) => p.endsWith(".migration.ts"))).toBe(true);
  });
});

describe("freeMigrationStamps", () => {
  it("gives a spec draft naming a taken timestamp the next free one, in allowed_paths, files_to_change and the text", () => {
    const { answer: out, renames } = freeMigrationStamps(answer([mig("20261122T1200"), test("20261122T1200")]), base);
    const a = out as ReturnType<typeof answer>;
    // 1200 and 1201 are taken (any component), 1202 is free.
    expect(a.allowed_paths).toEqual([mig("20261122T1202"), test("20261122T1202")]);
    expect(a.files_to_change).toEqual([mig("20261122T1202"), test("20261122T1202")]);
    expect(a.done_checks[0]!.test_file).toBe(test("20261122T1202"));
    expect(a.problem).toBe(`Add ${mig("20261122T1202")}`);
    expect(renames.get(mig("20261122T1200"))).toBe(mig("20261122T1202"));
  });

  it("skips every taken minute after the taken one", () => {
    const { answer: out } = freeMigrationStamps(answer([mig("20261122T1202"), mig("20261122T1203", "controller", "other")]), takenStamps([mig("20261122T1203", "bus", "topics")]));
    expect((out as ReturnType<typeof answer>).allowed_paths).toEqual([mig("20261122T1202"), mig("20261122T1204", "controller", "other")]);
  });

  it("gives two new migrations on one taken timestamp two different free minutes", () => {
    const { answer: out } = freeMigrationStamps(answer([mig("20261122T1200", "controller", "a"), mig("20261122T1200", "controller", "b")]), base);
    expect((out as ReturnType<typeof answer>).allowed_paths).toEqual([mig("20261122T1202", "controller", "a"), mig("20261122T1204", "controller", "b")]);
  });

  it("leaves a spec whose migration timestamps are all free unchanged", () => {
    const draft = answer([mig("20261123T0900"), test("20261123T0900"), "src/core/policy.ts"]);
    const { answer: out, renames } = freeMigrationStamps(draft, base);
    expect(out).toBe(draft);
    expect(renames.size).toBe(0);
  });

  it("keeps the name of an existing migration the spec edits", () => {
    const draft = answer([mig("20261122T1200", "controller", "schedules")]);
    expect(freeMigrationStamps(draft, base).answer).toBe(draft);
  });

  it("leaves <stamp> migrations for the implementer, even two in one answer", () => {
    const draft = answer([mig("<stamp>", "controller", "a"), mig("<stamp>", "controller", "b"), test("<stamp>", "controller", "a")]);
    const { answer: out, renames } = freeMigrationStamps(draft, base);
    expect(out).toBe(draft);
    expect(renames.size).toBe(0);
    expect(takenStamps([mig("<stamp>")]).size).toBe(0);
  });

  it("passes an answer that is not an object through", () => {
    expect(freeMigrationStamps(null, base).answer).toBeNull();
  });
});

describe("sameSlugMigrationOf", () => {
  it("covers any timestamp with the same folder, component and slug, for a migration and its test", () => {
    expect(sameSlugMigrationOf(mig("20261122T1202"), mig("20261122T1200"))).toBe(true);
    expect(sameSlugMigrationOf(mig("20261122T1159"), mig("20261122T1200"))).toBe(true);
    expect(sameSlugMigrationOf(test("20261122T1202"), test("20261122T1200"))).toBe(true);
  });

  it("covers any timestamp when the allowed path writes it as <stamp>", () => {
    expect(sameSlugMigrationOf(mig("20261125T0930"), mig("<stamp>"))).toBe(true);
    expect(sameSlugMigrationOf(test("20261125T0930"), test("<stamp>"))).toBe(true);
    expect(sameSlugMigrationOf(mig("<stamp>"), mig("<stamp>"))).toBe(true);
  });

  it("refuses another slug, another component or folder, or a test for a migration", () => {
    for (const allowed of [mig("20261122T1200"), mig("<stamp>")]) {
      expect(sameSlugMigrationOf(mig("20261122T1200", "controller", "other"), allowed)).toBe(false);
      expect(sameSlugMigrationOf(mig("20261122T1202", "worker"), allowed)).toBe(false);
      expect(sameSlugMigrationOf("src/worker/migrations/20261122T1202-controller-new-thing.migration.ts", allowed)).toBe(false);
      expect(sameSlugMigrationOf(test("20261122T1202"), allowed)).toBe(false);
    }
    expect(sameSlugMigrationOf(test("20261122T1202", "worker"), test("<stamp>"))).toBe(false);
    expect(sameSlugMigrationOf(mig("20261122T1202"), test("<stamp>"))).toBe(false);
    expect(sameSlugMigrationOf("src/controller/migrations/<stamps>-controller-new-thing.migration.ts", mig("<stamp>"))).toBe(false);
  });
});

describe("NoOpSandbox.listLocalFiles", () => {
  it("lists the files under a folder of the local base branch from objects, and null for a missing branch", async () => {
    const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "sf-stamps-"));
    try {
      const repo = join(root, "repo");
      const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: repo, encoding: "utf8" });
      mkdirSync(repo);
      git("init", "--quiet", "-b", "main");
      for (const p of [mig("20261122T1200", "controller", "schedules"), "src/core/x.ts", "README.md"]) {
        mkdirSync(dirname(join(repo, p)), { recursive: true });
        writeFileSync(join(repo, p), "x\n");
      }
      git("add", "-A");
      git("commit", "--quiet", "-m", "init");
      git("checkout", "--quiet", "-b", "work");
      const sandbox = new NoOpSandbox(join(root, "wt"));
      expect(await sandbox.listLocalFiles({ repo, ref: "main", path: "src/" })).toEqual([mig("20261122T1200", "controller", "schedules"), "src/core/x.ts"]);
      expect(await sandbox.listLocalFiles({ repo, ref: "nope", path: "src/" })).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
