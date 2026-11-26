import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AUTO_RESOLVE_LIMIT, autoResolveAttempts, autoResolveKey, nextAutoResolveAttempt, parseAutoResolveKey, runKey, scopeViolations,
} from "../src/core/policy.js";
import { MERGE_CONFLICT_PENDING, conflictCounts, conflictCountsLine, lastResolveFailure, renderResolvePrompt, resolveScopeViolations } from "../src/core/resolve.js";
import type { Run, StateChange, WorkItem } from "../src/core/types.js";
import type { EgressScanner } from "../src/interfaces/egress-scanner.js";
import { pipeline } from "./helpers/harness.js";
import { runComments } from "./helpers/fakes/config.js";
import { issue, system } from "./helpers/store.js";

// Pure rules of automatic conflict resolution (design §5 Merge conflict, decided 2026-11-02).

const z = (...paths: string[]) => paths.map((p) => `${p}\0`).join("");

describe("scope rule for conflicting files", () => {
  const allowed = ["src/core/", "docs/design.md"];

  it("implement path: a conflicting file outside allowed_paths passes", () => {
    expect(scopeViolations(z("src/core/a.ts", "package.json"), allowed, ["package.json"])).toEqual([]);
  });

  it("implement path: an unrelated file outside allowed_paths still fails, conflicts or not", () => {
    expect(scopeViolations(z("src/core/a.ts", "package.json", "README.md"), allowed, ["package.json"])).toEqual(["README.md"]);
    expect(scopeViolations(z("README.md"), allowed)).toEqual(["README.md"]);
  });

  it("resolve path: a file that is neither conflicting nor allowed fails; conflicting and allowed ones pass", () => {
    expect(resolveScopeViolations(z("package.json", "src/core/x.ts", "SET_UP.md"), ["package.json"], allowed)).toEqual(["SET_UP.md"]);
    expect(resolveScopeViolations(z("package.json", "src/core/x.ts"), ["package.json"], allowed)).toEqual([]);
  });
});

describe("automatic resolve attempts", () => {
  it("keys are per item, base commit and attempt, and parse back", () => {
    const k = autoResolveKey("wi_1", "abc123", 2);
    expect(k).toBe("wi_1:resolve:auto:abc123:2");
    expect(parseAutoResolveKey(k)).toEqual({ work_item_id: "wi_1", base_sha: "abc123", attempt: 2 });
  });

  it("a human /resolve key, or any other key, is not automatic", () => {
    expect(parseAutoResolveKey(runKey({ id: "wi_1" as never, loop_count: 0, restart_count: 1 }, "resolve"))).toBeNull();
    expect(parseAutoResolveKey("wi_1:update:42:h:b")).toBeNull();
    expect(parseAutoResolveKey("wi_1:resolve:auto:abc:0")).toBeNull();
  });

  it("the limit is 2 per base commit", () => {
    expect(AUTO_RESOLVE_LIMIT).toBe(2);
    expect(nextAutoResolveAttempt(0)).toBe(1);
    expect(nextAutoResolveAttempt(1)).toBe(2);
    expect(nextAutoResolveAttempt(2)).toBeNull();
  });

  it("counts only the item's automatic runs for that base; a new base starts at 0", () => {
    const keys = [
      autoResolveKey("wi_1", "b1", 1), autoResolveKey("wi_1", "b1", 2), autoResolveKey("wi_1", "b1", 2),
      autoResolveKey("wi_1", "b2", 1), autoResolveKey("wi_2", "b1", 1), "wi_1:resolve:l0:r1",
    ];
    expect(autoResolveAttempts(keys, "wi_1", "b1")).toBe(2);
    expect(autoResolveAttempts(keys, "wi_1", "b2")).toBe(1);
    expect(autoResolveAttempts(keys, "wi_1", "b3")).toBe(0);
  });
});

describe("conflict counts", () => {
  const run = (kind: Run["kind"], key: string, data: Record<string, unknown> | null): Pick<Run, "kind" | "idempotency_key" | "outcome"> => ({
    kind,
    idempotency_key: key,
    outcome: data ? { status: "succeeded", summary: "", data } : { status: "failed", error_code: "x", detail: "", infra: false },
  });
  const change = (to: string | null): Pick<StateChange, "changes"> => ({ changes: { blocked_reason: { from: null, to } } });

  it("automatic: pushed automatic resolves with conflicts and pushed implement syncs with conflicts", () => {
    const runs = [
      run("resolve", autoResolveKey("wi_1", "b1", 1), { result: "pushed", conflicts: ["a"] }),
      run("resolve", autoResolveKey("wi_1", "b2", 1), { result: "pushed", conflicts: [] }), // clean merge: no conflict
      run("resolve", autoResolveKey("wi_1", "b3", 1), null), // failed
      run("resolve", "wi_1:resolve:l0:r1", { result: "pushed", conflicts: ["a"] }), // a person asked
      run("implement", "wi_1:implement:l0:r0", { pr_number: 42, conflicts: ["b"] }),
      run("implement", "wi_1:implement:l1:r0", { pr_number: 42 }), // no conflict
      run("implement", "wi_1:implement:l2:r0", { floor_block: true, conflicts: ["b"] }), // nothing pushed
    ];
    expect(conflictCounts(runs, [])).toEqual({ automatic: 2, person: 0 });
  });

  it("person: every change that set merge_conflict_pending", () => {
    const changes = [change(MERGE_CONFLICT_PENDING), change("merge_pending"), change(null), change(MERGE_CONFLICT_PENDING), { changes: {} }];
    expect(conflictCounts([], changes)).toEqual({ automatic: 0, person: 2 });
  });

  it("one sentence states both counts", () => {
    expect(conflictCountsLine({ automatic: 3, person: 1 })).toBe(
      "Merge conflicts on this item so far: 3 resolved automatically, 1 needed a person.",
    );
  });
});

describe("resolve prompt fixed rules", () => {
  const prompt = readFileSync("prompts/resolve.md", "utf8");

  it("keeps both sides' sections in documents with sections, and defers to the repo's agent instructions", () => {
    expect(prompt).toMatch(/keep both sides' sections/i);
    expect(prompt).toContain("AGENTS.md");
  });

  it("AGENTS.md keeps both sides' sections in the design and plugin docs and SET_UP.md (moved from the prompt, issue #335)", () => {
    const lines = readFileSync("AGENTS.md", "utf8").split("\n");
    const rule = lines.find((l) => l.startsWith("- Merge conflicts in"));
    expect(rule, "the merge rule").toBeDefined();
    for (const doc of ["`docs/design.md`", "`SET_UP.md`", "`docs/design/", "`docs/plugins/"]) {
      expect(rule).toContain(doc);
    }
    expect(rule).toMatch(/keep both sides' sections/i);
    expect(rule, "docs/settings.md is generated, not hand-merged").not.toContain("docs/settings.md");
    expect(rule, "the docs/settings/ owner pages are generated, not hand-merged").not.toContain("docs/settings/");
    const generated = lines.find((l) => l.startsWith("- Generated files are regenerated on a conflict, never hand-merged"));
    for (const doc of ["`docs/settings.md`", "`docs/settings/`", "`npm run settings:catalog`"]) expect(generated, doc).toContain(doc);
  });

  it("says next to the allowed-paths rule that known-violations lists are always editable to shrink (never to grow)", () => {
    const rule = prompt.split("\n").find((l) => l.startsWith("- Change only the conflicting files"));
    expect(rule).toContain("known-violations lists are always editable to shrink (never to grow)");
  });

  it("renames a clashing migration by the repository's own naming rule when both sides added one", () => {
    expect(prompt).toMatch(/both sides add(ed)? a migration/i);
    expect(prompt).toMatch(/repository's own naming rule/);
    expect(prompt).not.toMatch(/mysql/i);
  });

  it("keeps both sides' entries in lists and tables", () => {
    expect(prompt).toMatch(/keep both sides' entries/i);
    expect(prompt).toMatch(/lists and tables/i);
  });
});

describe("resolve prompt", () => {
  const item = {
    id: "wi_1" as never, problem: "p", done_criteria: ["d"], scope: "s", allowed_paths: ["src/"],
    source: { type: "local" as const, id: "local-1", link: "" },
  };

  it("names the PR, or a local item's branch when it has none", () => {
    expect(renderResolvePrompt({ ...item, change_ref: "42" }, "origin/main", [], "").split("\n")[0]).toBe("# Resolve merge conflicts: work item wi_1, PR #42");
    expect(renderResolvePrompt({ ...item, change_ref: null }, "origin/main", [], "").split("\n")[0]).toBe("# Resolve merge conflicts: work item wi_1, local branch");
  });
});

// A resolve run whose checks fail (design 05-merge-conflict, 2026-11-18): it keeps the failing tests and the
// output tail, the next automatic attempt's prompt carries them, and a failure only in test files it could not
// edit asks for them. Fakes only: no model, no remote.
describe("a resolve run whose checks fail", () => {
  const OUTPUT = [" FAIL  tests/a.test.ts > keeps both sides", " FAIL  tests/b.test.ts > counts", "Test Files  2 failed"].join("\n");

  /** A pipeline whose `npm test` exits 1 printing `output`, a conflicted merge on src/a.ts, and the resolve agent scripted. */
  async function failing(output = OUTPUT, scanner?: EgressScanner) {
    const f = await pipeline(scanner ? { scanner } : {});
    f.runner.script.resolve = () => ({ output: { summary: "resolved", next_steps: "none" } });
    Object.assign(f.sandbox, { mergeExit: 1, conflicts: ["src/a.ts"], resolveChanged: ["src/a.ts"] });
    f.sandbox.files["src/a.ts"] = "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> origin/main\n";
    f.sandbox.exits["npm test"] = 1;
    const exec = f.sandbox.exec.bind(f.sandbox);
    f.sandbox.exec = async (h, cmd, o) => {
      const r = await exec(h, cmd, o);
      return cmd.join(" ") === "npm test" ? { ...r, stdout: output } : r;
    };
    return f;
  }

  /** An item with PR 42, RUNNING, and one queued resolve run keyed `key` (a function of the item id). */
  async function withResolve(f: Awaited<ReturnType<typeof pipeline>>, allowed: string[], key: (id: string) => string): Promise<WorkItem> {
    const { item } = await f.store.createWorkItem(issue(7), system);
    const moved = await f.store.transition({
      id: item.id, expected_version: item.version, actor: system, reason: "test_setup",
      patch: { stage: "RUNNING", change_ref: "42", allowed_paths: allowed },
      enqueue: { kind: "resolve", idempotency_key: key(item.id), input: { notes: "" } },
    });
    if (!moved.ok) throw new Error("setup");
    return moved.item;
  }

  it("stores failing_tests and output_tail in its failed outcome, and the item comment names the failing tests", async () => {
    const f = await failing();
    const item = await withResolve(f, ["src/", "tests/"], (id) => `${id}:resolve:l0:r1`);
    await f.w1.tick();
    const run = (await f.runs(item, "resolve"))[0]!;
    expect(run.outcome).toMatchObject({
      status: "failed", error_code: "tests_failed", conflicts: ["src/a.ts"],
      failing_tests: ["tests/a.test.ts > keeps both sides", "tests/b.test.ts > counts"], output_tail: OUTPUT,
    });
    expect(run.outcome?.status === "failed" && run.outcome.detail).toBe(
      "`npm test` exited 1; failing tests: tests/a.test.ts > keeps both sides, tests/b.test.ts > counts",
    );
    expect(f.broker.stores).toEqual([]);
    await f.controller.tickRuns();
    const comment = (await runComments(f.store, item.id)).find((c) => c.marker === `<!-- factory:run-failed:${run.id} -->`);
    expect(comment?.body).toContain("failing tests: tests/a.test.ts > keeps both sides, tests/b.test.ts > counts");
  });

  it("withholds a tail the egress scan flags, as the merge check does, and keeps the names", async () => {
    const flagging: EgressScanner = {
      scan: async (channel, text) => (text.includes("SECRETISH") ? { clean: false, findings: [{ rule: "test", channel }] } : { clean: true }),
    };
    const f = await failing(`${OUTPUT}\nSECRETISH`, flagging);
    const item = await withResolve(f, ["src/", "tests/"], (id) => `${id}:resolve:l0:r1`);
    await f.w1.tick();
    const run = (await f.runs(item, "resolve"))[0]!;
    expect(run.outcome).toMatchObject({ status: "failed", error_code: "tests_failed", output_tail: null });
    expect(run.outcome).toHaveProperty("failing_tests", ["tests/a.test.ts > keeps both sides", "tests/b.test.ts > counts"]);
  });

  it("the next automatic attempt's prompt contains the failing tests and the output tail", async () => {
    const f = await failing();
    const item = await withResolve(f, ["src/", "tests/"], (id) => autoResolveKey(id, "basesha", 1));
    await f.w1.tick();
    await f.controller.tickRuns();
    expect((await f.runs(item, "resolve")).map((r) => r.idempotency_key)).toEqual([
      autoResolveKey(item.id, "basesha", 1), autoResolveKey(item.id, "basesha", 2),
    ]);
    await f.w1.tick();
    const prompts = f.runner.specs.filter((s) => s.role === "resolve").map((s) => s.prompt);
    expect(prompts[0]).not.toContain("The last resolve attempt failed");
    expect(prompts[1]).toContain("## The last resolve attempt failed its checks");
    expect(prompts[1]).toContain("- `tests/a.test.ts > keeps both sides`");
    expect(prompts[1]).toContain("- `tests/b.test.ts > counts`");
    expect(prompts[1]).toContain(OUTPUT);
  });

  it("failing only in test files outside the allowed paths asks for those paths and pushes nothing", async () => {
    const f = await failing();
    const item = await withResolve(f, ["src/"], (id) => `${id}:resolve:l0:r1`);
    await f.w1.tick();
    const run = (await f.runs(item, "resolve"))[0]!;
    expect(run.outcome).toMatchObject({ status: "succeeded", data: { needs_human: { paths: ["tests/a.test.ts", "tests/b.test.ts"] } } });
    expect(run.outcome?.status === "succeeded" && String((run.outcome.data.needs_human as { reason: string }).reason)).toContain("outside the allowed paths");
    expect(f.broker.stores).toEqual([]);
    expect(f.broker.calls).toEqual([]);
  });
});

describe("the last failed resolve run", () => {
  const failedRun = (id: string, extra: Record<string, unknown>, code = "tests_failed") =>
    ({ id, kind: "resolve", outcome: { status: "failed", error_code: code, detail: "", infra: false, ...extra } }) as unknown as Run;

  it("is the most recent failed resolve run other than this one; another failure code gives nothing", () => {
    const runs = [
      failedRun("r1", { failing_tests: ["tests/old.test.ts > x"], output_tail: "old" }),
      failedRun("r2", { failing_tests: ["tests/new.test.ts > y"], output_tail: "new" }),
      failedRun("r3", {}),
    ];
    expect(lastResolveFailure(runs, "r3" as never)).toEqual({ failing_tests: ["tests/new.test.ts > y"], output_tail: "new" });
    expect(lastResolveFailure([...runs.slice(0, 2), failedRun("r4", { output_tail: "transcript" }, "invalid_output")], "r9" as never)).toBeNull();
    expect(lastResolveFailure([failedRun("r1", { output_tail: null, failing_tests: [] })], "r9" as never)).toBeNull();
  });

  it("an older run with only a tail still gives its tail; a withheld tail keeps the names", () => {
    expect(lastResolveFailure([failedRun("r1", { output_tail: "boom" })], "r9" as never)).toEqual({ failing_tests: [], output_tail: "boom" });
    const p = renderResolvePrompt({ id: "wi_1" as never, problem: "p", done_criteria: [], scope: "", allowed_paths: [], change_ref: null, source: { type: "local", id: "l", link: "" } },
      "origin/main", [], "", { failing_tests: ["tests/a.test.ts > b"], output_tail: null });
    expect(p).toContain("- `tests/a.test.ts > b`");
    expect(p).not.toContain("Its output, last lines");
  });
});
