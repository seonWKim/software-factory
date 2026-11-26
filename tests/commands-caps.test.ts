import { describe, expect, it } from "vitest";
import { commandPhase, refusalText } from "../src/core/commands.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { itemCommands } from "../src/ui/commands.js";
import type { UserId, WorkItem, WorkItemId } from "../src/core/types.js";
import { runLocalCli } from "../src/core/local-cli.js";
import { githubCommand } from "../src/core/command-inbox.js";
import type { AuthProvider } from "../src/interfaces/auth-provider.js";
import { answersDetail, splitAnswers } from "../src/shared/command-notes.js";
import { overCapNoteRequired, sizeCaps } from "../src/core/size-cap.js";
import { sizeDetail } from "../src/core/diff-gate.js";
import { runKey } from "../src/core/policy.js";
import { retry } from "../src/controller/units/support.js";
import { runKindLabel } from "../src/controller/units/run-results/run-kind-label.js";
import { FakeAuth } from "./helpers/fakes/runner.js";
import { FakeSource } from "./helpers/fakes/source.js";
import { cleanScanner, config, issueRef, silent } from "./helpers/fakes/config.js";
import { ROUTINE_CAP, addRoutine, carrierSource, holdSource, queueRoutineRun } from "../src/core/check-page.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { LocalSource } from "../src/impl/source/local-source.js";
import { tickAt } from "../src/shared/ticks/tick-generator.js";
import { scheduledAction } from "../src/core/controller-deps.js";
import { newStore, PROJECT_KEY, system, w1 } from "./helpers/store.js";

// An over-cap /approve at too_large (design 04-split-specs, 2026-11-24): the too_large comment names it; with no note one
// refusal, the same from a comment and from `factory approve`, and nothing stored; with a note `/retry`'s implement run
// and the one-time cap with its size_cap_approved record, in one transition.
describe("/approve over the cap at too_large", () => {
  const ME = "github:1" as UserId;
  const CAPS = { max_diff_lines: 1500, max_diff_files: 40 };
  const auth: AuthProvider = { resolve: async (i) => ({ user_id: `${i.provider}:${i.subject}` as UserId }), authorize: async () => ({ allow: true }) };

  async function tooLarge(n: number) {
    const { store, clock } = await newStore();
    const source = new FakeSource();
    const controller = new ControllerRole({ store, sources: [source], auth, clock, config, log: silent, scanner: cleanScanner });
    const { item } = await store.createWorkItem({ source: issueRef(n), requester_id: ME, project: PROJECT_KEY, problem: "p", resources: [] }, system);
    const t = await store.transition({ id: item.id, expected_version: item.version, actor: system, reason: "setup", patch: { stage: "RUNNING", tier: 2, allowed_paths: ["src/a/", "src/b/"] }, enqueue: { kind: "implement", idempotency_key: runKey(item, "implement") } });
    if (!t.ok) throw new Error("setup");
    const run = (await store.claimRun({ worker_id: w1, kinds: ["implement"], lease_ms: 60_000 }))!;
    await store.completeRun(run.id, run.lease!.token, { status: "failed", error_code: "diff_too_large", detail: sizeDetail({ lines: 5000, files: 60 }, CAPS), infra: false });
    await controller.tickRuns();
    let comments = 0;
    /** A GitHub comment `/approve [note]`; the controller's refusal for it, or undefined. */
    const approve = async (text: string) => {
      const id = 800 + ++comments;
      await store.appendCliCommand(githubCommand({ comment_id: id, user_id: 1, command: "approve", text, source: issueRef(n) }));
      await controller.tickCommands();
      return source.comments.find((c) => c.marker === `<!-- factory:refused:${id} -->`)?.body;
    };
    const cli = {
      answers: { split: splitAnswers, detail: answersDetail }, store, identity: { user: ME, from: "cli_user" as const }, project: async () => PROJECT_KEY, read: async () => "",
      newId: () => `n${++comments}`, caps: async () => CAPS,
    };
    return { store, source, controller, item: (await store.getWorkItem(item.id))!, approve, cli };
  }

  it("the too_large comment names /approve with the diff size, the cap and the proposed cap", async () => {
    const h = await tooLarge(1);
    expect(commandPhase(h.item)).toBe("too_large");
    const body = h.source.comments.find((c) => c.marker.startsWith("<!-- factory:run-failed:"))!.body;
    expect(body).toContain("`/approve <why>`");
    expect(body).toContain("5000 lines in 60 files against `max_diff_lines` = 1500 and `max_diff_files` = 40");
    expect(body).toContain("one-time cap of 5883 lines and 71 files");
  });

  it("with no note: one refusal, the same from a comment and from `factory approve`, and nothing stored", async () => {
    const h = await tooLarge(2);
    const runs = (await h.store.listRuns(h.item.id)).length;
    const before = (await h.store.listCliCommandsAfter(0, 100)).length;
    const typed = await runLocalCli(h.cli, { action: "command", command: "approve", id: h.item.id, text: "" });
    const reason = overCapNoteRequired({ sizes: { lines: 5000, files: 60 }, caps: CAPS, one_time_cap: { max_diff_lines: 5883, max_diff_files: 71 } });
    expect(typed).toEqual({ code: 1, lines: [refusalText("/approve", reason)] });
    expect((await h.store.listCliCommandsAfter(0, 100)).length).toBe(before);
    expect(await h.approve("")).toBe(typed.lines[0]);
    const after = (await h.store.getWorkItem(h.item.id))!;
    expect(after).toMatchObject({ version: h.item.version, blocked_reason: "run_failed:implement:diff_too_large" });
    expect((await h.store.listStateChanges(h.item.id)).some((c) => c.detail?.size_cap_approved !== undefined)).toBe(false);
    expect((await h.store.listRuns(h.item.id)).length).toBe(runs);
  });

  it("with a note from `factory approve`: /retry's implement run, keyed as /retry's, with the one-time cap and its record in one transition", async () => {
    const h = await tooLarge(3);
    const key = (retry(h.item, { kind: "user", id: ME }, "implement", "the generated table is one file", null, runKindLabel) as { enqueue: { idempotency_key: string } }).enqueue.idempotency_key;
    const typed = await runLocalCli(h.cli, { action: "command", command: "approve", id: h.item.id, text: "the generated table is one file" });
    expect(typed.code).toBe(0);
    await h.controller.tickCommands();
    const it = (await h.store.getWorkItem(h.item.id))!;
    expect(it).toMatchObject({ stage: "RUNNING", blocked_on: "none", blocked_reason: null });
    expect(it).not.toHaveProperty("size_cap");
    const queued = (await h.store.listRuns(it.id)).filter((r) => r.kind === "implement" && r.status === "queued");
    expect(queued.map((r) => r.idempotency_key)).toEqual([key]);
    const change = (await h.store.listStateChanges(it.id)).find((c) => typeof c.detail?.size_cap_approved === "string")!;
    expect(change.changes).not.toHaveProperty("size_cap");
    expect(sizeCaps(await h.store.listStateChanges(it.id), CAPS)).toEqual({ max_diff_lines: 5883, max_diff_files: 71 }); // its one-time cap, read from the record
    expect(JSON.parse(String(change.detail!.size_cap_approved))).toEqual({
      actor: `local:${ME}`, sizes: { lines: 5000, files: 60 }, project_cap: CAPS, one_time_cap: { max_diff_lines: 5883, max_diff_files: 71 }, note: "the generated table is one file",
    });
  });

  it("the item API's Approve row carries over_cap (size, caps in force, one-time cap); the other rows and a row read without caps do not", async () => {
    const h = await tooLarge(4);
    const runs = await h.store.listRuns(h.item.id);
    const rows = await itemCommands(h.item, runs, { allow: true }, async (v) => v, CAPS);
    expect(rows.find((r) => r.name === "approve")?.over_cap).toEqual({ sizes: { lines: 5000, files: 60 }, caps: CAPS, one_time_cap: { max_diff_lines: 5883, max_diff_files: 71 } });
    expect(rows.filter((r) => r.name !== "approve").every((r) => r.over_cap === undefined)).toBe(true);
    expect((await itemCommands(h.item, runs, { allow: true }, async (v) => v)).find((r) => r.name === "approve")?.over_cap).toBeUndefined();
  });

  it("an Approve on an item that is not over its caps carries no over_cap", async () => {
    const it_ = { ...(await tooLarge(5)).item, blocked_reason: "spec_pending", stage: "READY", blocked_on: "human" } as WorkItem;
    const row = (await itemCommands(it_, [], { allow: true }, async (v) => v, CAPS)).find((r) => r.name === "approve");
    expect(row).toBeDefined();
    expect(row && "over_cap" in row).toBe(false);
  });
});

describe("/approve and /reject at a routine's daily cap", () => {
  const OWNER = "github:1" as UserId;
  const HOUR = 3_600_000;

  /** A routine every hour from 08:59 (first slot 09:59) with a $1 daily cap; each run costs $0.60. */
  async function harness() {
    const clock = new FakeClock("2026-11-23T08:59:00.000Z");
    const { store } = await newStore(clock);
    const controller = new ControllerRole({ store, sources: [new LocalSource(store)], auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner , schedule_action: scheduledAction(store, { run: async (s, at) => void (await queueRoutineRun(store, config.project.key, s.id, at)) }, silent, config.project.key) });
    const added = await addRoutine(store, {
      id: "rt_1", name: "License", instruction: "Check the license.", url: null, schedule: { kind: "interval", spec: "60" }, zone: "UTC", trigger: null,
      run_cap_usd: null, daily_cap_usd: 1, created_by: OWNER,
    }, clock.now());
    if (!added.ok) throw new Error(added.problem);
    const tick = async () => {
      await (await controller.unit("schedule")).scheduleStep(tickAt("tick", 1, clock.now().getTime()));
    };
    const runs = async () => {
      const carrier = await store.getWorkItemBySource("local", carrierSource("rt_1").id);
      return carrier ? (await store.listRuns(carrier.id)).filter((r) => r.kind === "routine") : [];
    };
    const queued = async () => (await runs()).filter((r) => r.status === "queued").map((r) => r.idempotency_key);
    const finish = async () => {
      const run = (await store.claimRun({ worker_id: w1, kinds: ["routine"], lease_ms: 60_000 }))!;
      const usage = { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0.6, model: null };
      await store.completeRun(run.id, run.lease!.token, { status: "succeeded", summary: "s", data: { routine: { verdict: "pass", findings: [], summary: "s" }, usage } });
      await controller.tickRuns();
    };
    const hold = (slot: string) => store.getWorkItemBySource("local", holdSource("rt_1", slot).id);
    let n = 0;
    /** `/<name> <text>` on `id`, as the CLI stores it, then the controller's command poll. */
    const command = async (id: WorkItemId, name: string, text = "") => {
      await store.appendCliCommand({ key: `cli:routine-${++n}`, actor: "local:1", command: name, args: { item: id, ...(text ? { text } : {}) } });
      await controller.tickCommands();
    };
    /** The first run, at 09:59, finished: $0.60 spent today. */
    clock.advance(HOUR);
    await tick();
    await finish();
    return { clock, store, tick, queued, finish, hold, command, runs };
  }

  it("holds the run that would pass the cap; /approve raises it by the last run's cost and runs it; the cap holds again after", async () => {
    const h = await harness();
    h.clock.advance(HOUR);
    await h.tick();
    await h.tick();
    expect(await h.queued()).toEqual([]);
    const held = (await h.hold("2026-11-23T10:59:00.000Z"))!;
    expect(held).toMatchObject({ stage: "NEW", blocked_on: "human", blocked_reason: ROUTINE_CAP, requester_id: OWNER });
    expect(held.problem).toContain("Reply `/approve` to raise today's cap by $0.60");
    await h.command(held.id, "approve");
    expect(await h.store.getWorkItem(held.id)).toMatchObject({ stage: "CLOSED", close_reason: "completed" });
    expect((await h.store.listStateChanges(held.id)).at(-1)).toMatchObject({ reason: "routine_cap_approved", detail: { routine_id: "rt_1", raised_usd: 0.6 } });
    expect((await h.store.getRoutine("rt_1"))!.cap_raise).toEqual({ usd: 0.6, day: "2026-11-23", hold_key: held.source.id });
    await h.tick();
    expect(await h.queued()).toEqual(["routine:rt_1:2026-11-23T10:59:00.000Z"]);
    await h.finish();
    // $1.20 spent of a $1.60 cap: another $0.60 run would pass it, so the next slot is held too.
    h.clock.advance(HOUR);
    await h.tick();
    expect(await h.queued()).toEqual([]);
    expect(await h.hold("2026-11-23T11:59:00.000Z")).toMatchObject({ blocked_on: "human", blocked_reason: ROUTINE_CAP });
  });

  it("/reject skips the held run and the cap still holds; the next day's slot runs", async () => {
    const h = await harness();
    h.clock.advance(HOUR);
    await h.tick();
    const held = (await h.hold("2026-11-23T10:59:00.000Z"))!;
    await h.command(held.id, "reject", "not today");
    expect(await h.store.getWorkItem(held.id)).toMatchObject({ stage: "CLOSED", close_reason: "rejected" });
    expect((await h.store.listStateChanges(held.id)).at(-1)).toMatchObject({ reason: "routine_cap_rejected" });
    await h.tick();
    expect(await h.queued()).toEqual([]);
    expect(await h.store.getRoutine("rt_1")).toMatchObject({ next_due_at: "2026-11-23T11:59:00.000Z", cap_raise: null });
    h.clock.advance(HOUR);
    await h.tick();
    const again = (await h.hold("2026-11-23T11:59:00.000Z"))!;
    expect(again).toMatchObject({ blocked_on: "human", blocked_reason: ROUTINE_CAP });
    h.clock.set(new Date("2026-11-24T00:30:00.000Z"));
    await h.tick();
    expect(await h.queued()).toEqual([]); // a held slot waits for its answer, a new day included
    await h.command(again.id, "reject");
    await h.tick();
    expect(await h.store.getRoutine("rt_1")).toMatchObject({ next_due_at: "2026-11-24T00:59:00.000Z" });
    h.clock.advance(30 * 60_000);
    await h.tick();
    expect(await h.queued()).toEqual(["routine:rt_1:2026-11-24T00:59:00.000Z"]);
  });

  it("refuses any other command on a hold item, and changes nothing", async () => {
    const h = await harness();
    h.clock.advance(HOUR);
    await h.tick();
    const held = (await h.hold("2026-11-23T10:59:00.000Z"))!;
    await h.command(held.id, "retry");
    expect(await h.store.getWorkItem(held.id)).toMatchObject({ stage: "NEW", blocked_on: "human", version: held.version });
    expect((await h.store.listItemMessages(held.id)).map((m) => m.body).join("\n")).toContain("a routine's held run takes `/approve`");
    expect((await h.store.getRoutine("rt_1"))!.cap_raise).toBeNull();
  });
});
