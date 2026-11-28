import { describe, expect, it } from "vitest";
import { ALREADY_DONE_MAX_CHARS, parseImplement } from "../src/core/outputs.js";
import { PHASE_HOLD, PHASES_OPEN } from "../src/core/split.js";
import type { RunOutcome, UserId, WorkItem, WorkItemId } from "../src/core/types.js";
import { OwnerAuth } from "../src/core/authorize.js";
import { type CliAction, type LocalCliDeps, runLocalCli } from "../src/core/local-cli.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { LocalSource } from "../src/impl/source/local-source.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { answersDetail, splitAnswers } from "../src/shared/command-notes.js";
import { cleanScanner, config, silent, triageSpec } from "./helpers/fakes/config.js";
import { pipeline } from "./helpers/harness.js";
import { PROJECT_KEY, newStore, system, w1 } from "./helpers/store.js";

// An already-done phase (design 04-pre-push-gates and 04-split-specs, decided 2026-11-28): an implement run with no
// commits that answers already_done goes through the check gate on the base and closes the item as completed with no
// merge sha; a failing check fails it with checks_failed; no commits without already_done still fails with no_commits.

const DONE_TEXT = "tests/schedule-grants.test.ts passed 24/24 on the base";
const CHECKS = [["npm", "run", "typecheck"], ["npm", "test"]];

describe("the implement answer's already_done", () => {
  it("is read when set, trimmed, and over its limit it is refused", () => {
    const v = parseImplement({ summary: "s", next_steps: "n", already_done: `  ${DONE_TEXT} ` });
    expect(v).toMatchObject({ ok: true, value: { already_done: DONE_TEXT } });
    expect(parseImplement({ summary: "s", next_steps: "n", already_done: "  " })).toMatchObject({ ok: true, value: { summary: "s" } });
    expect((parseImplement({ summary: "s", next_steps: "n", already_done: "  " }) as { value: object }).value).not.toHaveProperty("already_done");
    expect(parseImplement({ summary: "s", next_steps: "n", already_done: "x".repeat(ALREADY_DONE_MAX_CHARS + 1) })).toEqual({ ok: false, error: "already_done" });
    expect(parseImplement({ summary: "s", next_steps: "n", already_done: 3 })).toEqual({ ok: false, error: "already_done" });
  });
});

describe("an implement run that answers already_done", () => {
  const answering = () => ({ output: { summary: "nothing to change", next_steps: "none", already_done: DONE_TEXT } });

  it("with no commits and passing checks closes the item completed with no merge sha; the checks ran and nothing was pushed", async () => {
    const f = await pipeline({ implement: answering, config: { repo: { ...config.repo, check_commands: CHECKS } } });
    f.sandbox.commits = [];
    const item = await f.submit();
    await f.step();
    expect(await f.item(item)).toMatchObject({ stage: "CLOSED", close_reason: "completed", merge_sha: null, blocked_on: "none" });
    const [run] = await f.runs(item, "implement");
    expect(run!.outcome).toMatchObject({ status: "succeeded", data: { already_done: DONE_TEXT, commits: 0 } });
    expect(run!.acknowledged_at).not.toBeNull();
    // The check list, then the item's done check (its test file), as before a push.
    expect(f.sandbox.commands.filter((c) => c.startsWith("npm"))).toEqual(["npm run typecheck", "npm test", "npm test -- tests/scope-gate.test.ts"]);
    expect(await f.runs(item, "review")).toEqual([]);
    expect((await f.store.listItemMessages(item.id)).some((m) => m.body.includes("## Factory: already done") && m.body.includes(DONE_TEXT))).toBe(true);
  });

  it("with a failing check fails with checks_failed and the item does not close; no fix step runs", async () => {
    const f = await pipeline({ implement: answering, config: { repo: { ...config.repo, check_commands: CHECKS } } });
    f.sandbox.commits = [];
    f.sandbox.exits["npm test"] = 1;
    const item = await f.submit();
    await f.step();
    const [run] = await f.runs(item, "implement");
    expect(run!.outcome).toMatchObject({ status: "failed", error_code: "checks_failed" });
    expect((await f.item(item)).stage).not.toBe("CLOSED");
    expect(f.runner.specs.filter((s) => s.role === "implement" && s.prompt.includes("## Checks failed before push"))).toEqual([]);
  });

  it("with commits is not read: the run goes to review as any other", async () => {
    const f = await pipeline({ implement: answering, config: { repo: { ...config.repo, check_commands: CHECKS } } });
    const item = await f.submit();
    await f.step();
    const [run] = await f.runs(item, "implement");
    expect(run!.outcome).toMatchObject({ status: "succeeded" });
    expect(run!.outcome!.status === "succeeded" && run!.outcome!.data).not.toHaveProperty("already_done");
    expect((await f.item(item)).close_reason).toBeNull();
  });

  it("with no commits and no already_done still fails with no_commits", async () => {
    const f = await pipeline({ config: { repo: { ...config.repo, check_commands: CHECKS } } });
    f.sandbox.commits = [];
    const item = await f.submit();
    await f.step();
    const [run] = await f.runs(item, "implement");
    expect(run!.outcome).toMatchObject({ status: "failed", error_code: "no_commits" });
    expect(f.sandbox.commands.some((c) => c.startsWith("npm"))).toBe(false);
  });
});

// The controller side, on a local split: the phase's implement result is applied as a worker stores it.
const ME = "local:me@example.com" as UserId;
const twoPhases = {
  ...triageSpec, estimated_lines: 2600, estimated_files: 30,
  phases: [1, 2].map((n) => ({ title: `Part ${n}`, problem: `Problem of part ${n}`, done_criteria: [`part ${n} works`], allowed_paths: [`src/p${n}/`] })),
};

async function split() {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const controller = new ControllerRole({ store, sources: [new LocalSource(store)], auth: new OwnerAuth(store), clock, config, log: silent, scanner: cleanScanner });
  let n = 0;
  const cli = (a: CliAction) => {
    const d: LocalCliDeps = { answers: { split: splitAnswers, detail: answersDetail }, store, identity: { user: ME, from: "git user.email" }, project: async () => PROJECT_KEY, read: async () => "the body", newId: () => `id${++n}` };
    return runLocalCli(d, a);
  };
  const id = (await cli({ action: "create", title: "Big change", bodyFile: "b" })).lines[0] as WorkItemId;
  await controller.tickIntake();
  clock.advance(24 * 3_600_000);
  const triage = await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: 60_000 });
  await store.completeRun(triage!.id, triage!.lease!.token, { status: "succeeded", summary: "s", data: { spec: twoPhases } });
  await controller.tickRuns();
  await cli({ action: "command", command: "approve", id, text: "" });
  await controller.tickIntake();
  const phases = (await store.listPhases(id)) as [WorkItem, WorkItem];
  const get = async (x: WorkItemId) => (await store.getWorkItem(x))!;
  /** Phase `it` implementing, its implement run finished with `outcome` and applied. */
  const implemented = async (it: WorkItem, outcome: RunOutcome) => {
    const cur = await get(it.id);
    const t = await store.transition({ id: it.id, expected_version: cur.version, actor: system, reason: "setup", patch: { stage: "RUNNING", blocked_on: "none", blocked_reason: null }, enqueue: { kind: "implement", idempotency_key: `${it.id}:implement` } });
    expect(t.ok).toBe(true);
    const run = await store.claimRun({ worker_id: w1, kinds: ["implement"], lease_ms: 60_000 });
    expect(run!.work_item_id).toBe(it.id);
    await store.completeRun(run!.id, run!.lease!.token, outcome);
    await controller.tickRuns();
  };
  return { store, controller, parent: id, phases, get, implemented };
}

const alreadyDone: RunOutcome = { status: "succeeded", summary: "s", data: { already_done: DONE_TEXT, commits: 0 } };

describe("an already-done phase of a split", () => {
  it("closes completed with no merge sha and completes its linked task; the next phase releases, and the last closes the parent", async () => {
    const f = await split();
    const [one, two] = f.phases;
    await f.store.addTask({ id: "tk_one", title: "one", list: null, priority: null, due: null, due_time: null, recurrence: null, created_by: ME });
    await f.store.linkTask("tk_one", one.id);
    expect(await f.get(two.id)).toMatchObject({ blocked_reason: PHASE_HOLD });

    await f.implemented(one, alreadyDone);
    expect(await f.get(one.id)).toMatchObject({ stage: "CLOSED", close_reason: "completed", merge_sha: null });
    expect((await f.store.getTask("tk_one"))!.done_at).not.toBeNull();
    await f.controller.tickPhases();
    expect(await f.get(two.id)).toMatchObject({ stage: "NEW", blocked_on: "none", blocked_reason: null });
    expect(await f.get(f.parent)).toMatchObject({ stage: "READY", blocked_reason: PHASES_OPEN });

    await f.implemented(two, alreadyDone);
    await f.controller.tickPhases();
    await f.controller.tickPhases();
    expect(await f.get(f.parent)).toMatchObject({ stage: "CLOSED", close_reason: "completed" });
  });

  it("a phase whose run failed with checks_failed after already_done stays open and keeps the next phase held", async () => {
    const f = await split();
    const [one, two] = f.phases;
    await f.implemented(one, { status: "failed", error_code: "checks_failed", detail: "the implementer answered already_done, but `npm test` exited 1", infra: false });
    expect((await f.get(one.id)).stage).not.toBe("CLOSED");
    await f.controller.tickPhases();
    expect(await f.get(two.id)).toMatchObject({ blocked_reason: PHASE_HOLD });
  });
});
