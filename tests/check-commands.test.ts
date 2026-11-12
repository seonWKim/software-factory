import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/compose.js";
import { checkCommands, redact } from "../src/core/checks.js";
import type { WorkItem } from "../src/core/types.js";
import { STORE_BRANCH } from "../src/interfaces/tool-broker.js";
import { config, pipeline, runComments } from "./helpers/fakes.js";
import { issue, system } from "./helpers/store.js";

// repo.check_commands (design §4, decided 2026-11-03): one list of checks, run before every push, in the
// implement, update and resolve runs. Absent: [repo.test_command].

const REPO_ROOT = join(import.meta.dirname, "..");
const REAL = JSON.parse(readFileSync(join(REPO_ROOT, "factory.config.json"), "utf8")) as Record<string, unknown> & {
  repo: Record<string, unknown>;
};
const WORKFLOW = readFileSync(join(REPO_ROOT, ".github", "workflows", "test.yml"), "utf8");

/** The unique `run:` steps of a workflow, in order, read as text (no YAML dependency). */
function workflowRuns(yaml: string): string[] {
  const runs = [...yaml.matchAll(/^\s*-\s+run:\s*(.+?)\s*$/gm)].map((m) => m[1]!.replace(/^(["'])(.*)\1$/, "$2"));
  return [...new Set(runs)];
}

/**
 * What differs between the workflow's checks and repo.check_commands: a `run:` step with no matching entry, or
 * an entry with no step. `npm ci` installs; it is not a check.
 */
function drift(yaml: string, checks: readonly (readonly string[])[]): string[] {
  const steps = workflowRuns(yaml).filter((r) => r !== "npm ci");
  const listed = checks.map((c) => c.join(" "));
  return [
    ...steps.filter((s) => !listed.includes(s)).map((s) => `workflow step \`${s}\` has no repo.check_commands entry`),
    ...listed.filter((c) => !steps.includes(c)).map((c) => `repo.check_commands entry \`${c}\` has no workflow step`),
  ];
}

describe("repo.check_commands follows .github/workflows/test.yml", () => {
  it("every run: step (but npm ci) has a check_commands entry, and every entry a step", () => {
    expect(drift(WORKFLOW, REAL.repo.check_commands as string[][])).toEqual([]);
    expect(workflowRuns(WORKFLOW)).toEqual(["npm ci", "npm run typecheck", "npm test"]);
  });

  it("a new run: step without its check_commands entry fails", () => {
    const yaml = WORKFLOW.replace("      - run: npm test\n", "      - run: npm test\n      - run: npm run lint\n");
    expect(drift(yaml, REAL.repo.check_commands as string[][])).toEqual(["workflow step `npm run lint` has no repo.check_commands entry"]);
  });

  it("a check_commands entry without its run: step fails", () => {
    const checks = [...(REAL.repo.check_commands as string[][]), ["npm", "run", "lint"]];
    expect(drift(WORKFLOW, checks)).toEqual(["repo.check_commands entry `npm run lint` has no workflow step"]);
    const yaml = WORKFLOW.replace("      - run: npm run typecheck\n", "");
    expect(drift(yaml, REAL.repo.check_commands as string[][])).toEqual(["repo.check_commands entry `npm run typecheck` has no workflow step"]);
  });
});

describe("repo.check_commands config", () => {
  function root(cfg: Record<string, unknown>): string {
    const dir = mkdtempSync(join(tmpdir(), "sf-checks-cfg-"));
    mkdirSync(join(dir, "prompts"));
    for (const p of ["triage", "implement", "review"]) writeFileSync(join(dir, "prompts", `${p}.md`), p);
    writeFileSync(join(dir, "factory.config.json"), JSON.stringify({ ...cfg, store: { type: "sqlite" }, state_dir: "state" }));
    return dir;
  }
  const withChecks = (value: unknown) => ({ ...REAL, repo: { ...REAL.repo, check_commands: value } });
  const withoutChecks = () => {
    const { check_commands: _, ...repo } = REAL.repo;
    return { ...REAL, repo };
  };

  it("the checked-in config runs the typecheck, then the tests", async () => {
    const loaded = await loadConfig(root(REAL), { platform: "linux" });
    expect(loaded.config.repo.check_commands).toEqual([["npm", "run", "typecheck"], ["npm", "test"]]);
    expect(checkCommands(loaded.config.repo)).toEqual([["npm", "run", "typecheck"], ["npm", "test"]]);
  });

  it("absent: the check list is [test_command]", async () => {
    const loaded = await loadConfig(root(withoutChecks()), { platform: "linux" });
    expect(loaded.config.repo).not.toHaveProperty("check_commands");
    expect(checkCommands(loaded.config.repo)).toEqual([["npm", "test"]]);
    expect(checkCommands({ ...config.repo, test_command: ["make", "check"] })).toEqual([["make", "check"]]);
  });

  it("rejects anything but a non-empty list of argv at startup", async () => {
    for (const bad of [[], "npm test", ["npm", "test"], [[]], [["npm", 1]], [[""]]]) {
      await expect(loadConfig(root(withChecks(bad)), { platform: "linux" }), JSON.stringify(bad)).rejects.toThrow(/repo\.check_commands/);
    }
  });

  it("an unknown repo key still fails, and check_commands is a known one", async () => {
    await expect(loadConfig(root({ ...REAL, repo: { ...REAL.repo, check_command: [["x"]] } }), { platform: "linux" })).rejects.toThrow(
      /did you mean "check_commands"/,
    );
  });
});

describe("repo.ui_check config (UI check at merge)", () => {
  function root(cfg: Record<string, unknown>): string {
    const dir = mkdtempSync(join(tmpdir(), "sf-ui-check-cfg-"));
    mkdirSync(join(dir, "prompts"));
    for (const p of ["triage", "implement", "review"]) writeFileSync(join(dir, "prompts", `${p}.md`), p);
    writeFileSync(join(dir, "factory.config.json"), JSON.stringify({ ...cfg, store: { type: "sqlite" }, state_dir: "state" }));
    return dir;
  }
  const withUiCheck = (value: unknown) => ({ ...REAL, repo: { ...REAL.repo, ui_check: value } });
  const withoutUiCheck = () => {
    const { ui_check: _, ...repo } = REAL.repo;
    return { ...REAL, repo };
  };
  const command = ["npm", "run", "check:responsive"];

  it("absent: off, nothing set", async () => {
    const loaded = await loadConfig(root(withoutUiCheck()), { platform: "linux" });
    expect(loaded.config.repo).not.toHaveProperty("ui_check");
  });

  it("an argv command; paths default to web/ and src/ui/, or are the configured prefixes", async () => {
    const plain = await loadConfig(root(withUiCheck({ command })), { platform: "linux" });
    expect(plain.config.repo.ui_check).toEqual({ command, paths: ["web/", "src/ui/"] });
    const set = await loadConfig(root(withUiCheck({ command, paths: ["app/"] })), { platform: "linux" });
    expect(set.config.repo.ui_check).toEqual({ command, paths: ["app/"] });
  });

  it("rejects a bad value at startup, naming the key", async () => {
    const bad = [
      "npm run check:responsive", command, null, {}, { command: "npm" }, { command: [] }, { command: [""] },
      { command, paths: [] }, { command, paths: "web/" }, { command, paths: [""] }, { command, paths: [1] }, { command, path: ["web/"] },
    ];
    for (const value of bad) {
      await expect(loadConfig(root(withUiCheck(value)), { platform: "linux" }), JSON.stringify(value)).rejects.toThrow(/repo\.ui_check/);
    }
  });

  it("ui_check is a known repo key", async () => {
    await expect(loadConfig(root({ ...REAL, repo: { ...REAL.repo, ui_chek: { command } } }), { platform: "linux" })).rejects.toThrow(
      /did you mean "ui_check"/,
    );
  });
});

describe("redact", () => {
  it("replaces every value, longest first, and skips empty ones", () => {
    expect(redact("mysql://u:pw@h/db and pw", ["pw", "mysql://u:pw@h/db", ""])).toBe("[redacted] and [redacted]");
  });
});

describe("update and resolve runs run the check list", () => {
  const checks = [["npm", "run", "typecheck"], ["npm", "test"]];

  /** An item with PR 42 and one queued run of `kind`. */
  async function withRun(f: Awaited<ReturnType<typeof pipeline>>, kind: "update" | "resolve"): Promise<WorkItem> {
    const { item } = await f.store.createWorkItem(issue(7), system);
    const moved = await f.store.transition({
      id: item.id, expected_version: item.version, actor: system, reason: "test_setup",
      patch: { stage: "RUNNING", change_ref: "42", allowed_paths: ["src/"] },
      enqueue: { kind, idempotency_key: `${kind}-1` },
    });
    if (!moved.ok) throw new Error("setup");
    return moved.item;
  }
  // The worker's own file commands (conflict reads, index copies, the resolve step's bundle) are not gates.
  const gateCommands = (f: Awaited<ReturnType<typeof pipeline>>) =>
    f.sandbox.commands.filter((c) => !c.startsWith("cat ") && !c.startsWith("cp ") && !c.includes("sf-run.bundle"));

  it("update: every check runs on the merged branch in place of test_command, then the push", async () => {
    const f = await pipeline({ config: { repo: { ...config.repo, check_commands: checks } } });
    f.sandbox.ancestorExit = 1;
    const item = await withRun(f, "update");
    expect(await f.w1.tick()).toBe(true);
    expect(gateCommands(f)).toEqual(["npm run typecheck", "npm test"]);
    const run = (await f.runs(item, "update"))[0]!;
    expect(run.outcome).toMatchObject({ status: "succeeded", data: { result: "pushed" } });
    // The run stores the merge; the push is outbound's (RFC 0015 M7).
    expect([f.broker.stores.map((c) => c.name), f.broker.calls]).toEqual([[STORE_BRANCH], []]);
    expect((await runComments(f.store, item.id)).map((c) => c.body).join("\n")).toContain("`npm run typecheck`, `npm test` passed");
  });

  it("update: the first failing check stops the list; nothing is pushed and the comment names it", async () => {
    const f = await pipeline({ config: { repo: { ...config.repo, check_commands: checks } } });
    f.sandbox.ancestorExit = 1;
    f.sandbox.exits["npm run typecheck"] = 2;
    const item = await withRun(f, "update");
    await f.w1.tick();
    expect(gateCommands(f)).toEqual(["npm run typecheck"]);
    const run = (await f.runs(item, "update"))[0]!;
    expect(run.outcome).toMatchObject({
      status: "succeeded", data: { result: "tests_failed", command: "npm run typecheck", exit_code: 2, timed_out: false },
    });
    expect(f.broker.calls).toEqual([]);
    expect((await runComments(f.store, item.id)).map((c) => c.body).join("\n")).toContain("`npm run typecheck` exited 2");
  });

  it("resolve: install_command first, then every check, then the push", async () => {
    const f = await pipeline({ config: { repo: { ...config.repo, check_commands: checks } } });
    const item = await withRun(f, "resolve");
    expect(await f.w1.tick()).toBe(true);
    expect(gateCommands(f)).toEqual(["npm ci", "npm run typecheck", "npm test"]);
    const run = (await f.runs(item, "resolve"))[0]!;
    expect(run.outcome).toMatchObject({ status: "succeeded", data: { result: "pushed" } });
  });

  it("resolve: a failing check fails the run with tests_failed and pushes nothing", async () => {
    const f = await pipeline({ config: { repo: { ...config.repo, check_commands: checks } } });
    f.sandbox.exits["npm test"] = 1;
    const item = await withRun(f, "resolve");
    await f.w1.tick();
    expect(gateCommands(f)).toEqual(["npm ci", "npm run typecheck", "npm test"]);
    const run = (await f.runs(item, "resolve"))[0]!;
    expect(run.outcome).toMatchObject({ status: "failed", error_code: "tests_failed", detail: "`npm test` exited 1" });
    expect(f.broker.stores).toEqual([]);
  });
});
