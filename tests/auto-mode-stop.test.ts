import { describe, expect, it } from "vitest";
import { lastAutoStop, openAlarms } from "../src/ui/alarms.js";
import { systemActions } from "../src/ui/system-actions.js";
import type { ChildRestart } from "../src/interfaces/updater.js";
import { RECURRING_FAILURE, type WorkerId } from "../src/core/types.js";
import { AUTO_ACTOR } from "../src/core/policy.js";
import type { NoOpSandbox } from "../src/impl/sandbox/noop-sandbox.js";
import type { Sandbox } from "../src/interfaces/sandbox.js";
import { config } from "./helpers/fakes/config.js";
import { ME, UI_CHANGE, autoFactory, git, stopped, uiAfterMerge } from "./helpers/classifier.js";

describe("auto mode: stop conditions", { timeout: 60_000 }, () => {
  it("red main: the checks fail on the new base tip after an auto merge, so the mode goes back to manual", async () => {
    const failing = (s: NoOpSandbox): Sandbox => new Proxy(s, {
      get: (t, k) => (k === "exec" ? async () => ({ exit_code: 1, signal: null, stdout: "", stderr: "", timed_out: false }) : Reflect.get(t, k, t)),
    });
    const f = await autoFactory({ controllerSandbox: failing });
    await f.setting("auto_merge_max_tier", 3);
    await f.mode("auto");
    const first = await f.create();
    await f.step();
    await f.approveRun(first);
    expect(await f.store.getWorkItem(first)).toMatchObject({ stage: "CLOSED", close_reason: "completed" });
    await stopped(f, "red_main");
    // The stop is in force: its time and cause reach the Mode toggle and the system banner.
    const [alert] = (await f.store.listAlerts({ limit: 10 })).filter((a) => a.pattern === "auto_stopped");
    // The failing command printed nothing: no test names and no tail to keep.
    expect(await lastAutoStop(f.store)).toEqual({ alert_id: alert!.id, at: alert!.created_at, cause: "red_main", failing_tests: [], output_tail: null });
    const actions = await systemActions({ store: f.store, factory: null, deps: {}, now: f.clock.now(), dashboardRev: null });
    const line = actions.find((a) => a.auto_stop)!;
    expect(line.auto_stop).toMatchObject({ alert_id: alert!.id, cause: "red_main" });
    expect(line.text).toContain("Alarm: back to manual: the checks failed on the base branch after a merge");
    // The time is a field (`auto_stop.at`), never inside the sentence.
    expect(line.text).not.toMatch(/\d{4}-\d{2}-\d{2}|UTC/);
    expect(line.auto_stop!.at).toBe(alert!.created_at);
    // Manual again: the next spec waits.
    const next = await f.create();
    await f.step();
    expect(await f.store.getWorkItem(next)).toMatchObject({ stage: "READY", blocked_reason: "spec_pending" });
  });

  it("red main from the UI check: after an auto merge it runs on the new base tip; a failure raises one red_main alert on that tip, files its fix item and stops auto mode", async () => {
    // The change touches a UI path; the UI check passes at its merge check and fails on the base tip after the merge.
    const command = uiAfterMerge("echo 'FAIL  tests/layout.test.ts > fits'; echo layout broken; exit 1");
    const f = await autoFactory({ spec: UI_CHANGE, ui_check: { command, paths: ["web/"] } });
    await f.setting("auto_merge_max_tier", 3);
    await f.mode("auto");
    const first = await f.create();
    await f.step();
    await f.approveRun(first);
    expect(await f.store.getWorkItem(first)).toMatchObject({ stage: "CLOSED", close_reason: "completed" });
    await stopped(f, "red_main");
    const tip = git(f.repo, "rev-parse", "main");
    const red = (await f.store.listAlerts({ limit: 10 })).filter((a) => a.pattern === "red_main");
    expect(red.map((a) => a.pattern_key)).toEqual([`red_main:${tip}`]);
    // The alert's detail keeps the sentence, the failing tests by name and the output tail (no new column).
    expect(JSON.parse(red[0]!.detail!)).toEqual({
      text: `\`${command.join(" ")}\` exited 1 on the new tip of \`main\``,
      failing_tests: ["tests/layout.test.ts > fits"],
      output_tail: "FAIL  tests/layout.test.ts > fits\nlayout broken\n",
    });
    // The overview's red_main alarm and the stop carry them to What failed.
    const actions = await systemActions({ store: f.store, factory: null, deps: {}, now: f.clock.now(), dashboardRev: null });
    expect(actions.find((a) => a.pattern === "red_main")).toMatchObject({ failing_tests: ["tests/layout.test.ts > fits"], output_tail: "FAIL  tests/layout.test.ts > fits\nlayout broken\n" });
    expect((await lastAutoStop(f.store))).toMatchObject({ cause: "red_main", failing_tests: ["tests/layout.test.ts > fits"] });
    const fixes = await f.store.db.all("SELECT intent_key FROM outbound_actions WHERE action = 'file_fix_item'");
    expect(fixes.map((r) => r.intent_key)).toEqual([`file_fix_item:red_main:${tip}`]);
  });

  it("red main from the UI check with a tail the egress scan flags: the tail is stored as null and the test names are kept", async () => {
    // The key is put together by the shell, so only the output holds it, not the command in the sentence.
    const print = "printf 'FAIL  tests/layout.test.ts > fits\\nAKIA%s\\n' ABCDEFGHIJKLMNOP; exit 1";
    const f = await autoFactory({ spec: UI_CHANGE, ui_check: { command: uiAfterMerge(print), paths: ["web/"] } });
    await f.setting("auto_merge_max_tier", 3);
    await f.mode("auto");
    const first = await f.create();
    await f.step();
    await f.approveRun(first);
    await stopped(f, "red_main");
    const [red] = (await f.store.listAlerts({ limit: 10 })).filter((a) => a.pattern === "red_main");
    expect(JSON.parse(red!.detail!)).toMatchObject({ failing_tests: ["tests/layout.test.ts > fits"], output_tail: null });
    expect(red!.detail).not.toContain("AKIA" + "ABCDEFGHIJKLMNOP");
  });

  it("red main at the merge check in auto mode: the change stays queued, one red_main alert is stored and auto mode stops", async () => {
    const f = await autoFactory({ spec: { allowed_paths: ["web/"], files_to_change: ["web/app.css"] }, ui_check: { command: ["sh", "-c", "exit 1"], paths: ["web/"] } });
    await f.setting("auto_merge_max_tier", 3);
    await f.mode("auto");
    const main = git(f.repo, "rev-parse", "main");
    const id = await f.create();
    await f.step();
    await f.approveRun(id);
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "REVIEW", loop_count: 0, merge_sha: null });
    expect(git(f.repo, "rev-parse", "main")).toBe(main);
    expect((await (await f.controller.unit("merge-queue")).entries(id)).map((e) => e.state)).toEqual(["queued"]);
    expect(await f.store.getWorkItem(id)).toMatchObject({ blocked_on: "ci", blocked_reason: "merge_queued" });
    expect((await f.store.listAlerts({ limit: 10 })).filter((a) => a.pattern === "red_main").map((a) => a.pattern_key)).toEqual([`red_main:${main}`]);
    await stopped(f, "red_main");
    // A later auto pass on the queued item records nothing new.
    await f.mode("auto");
    const before = (await f.changes(id)).length;
    await (await f.controller.unit("local-merge")).autoMergeStep();
    expect((await f.changes(id)).length).toBe(before);
    expect(await f.store.getWorkItem(id)).toMatchObject({ blocked_on: "ci", blocked_reason: "merge_queued" });
  });

  it("a burst of agent-run failures leaves the mode auto: the alarm is open and the failing item is held", async () => {
    const f = await autoFactory({ spec: { tier: 9 } });
    await f.setting("alarm_repeat_count", 1);
    await f.mode("auto");
    const id = await f.create();
    // An invalid triage answer fails its run: one failed run is a burst at alarm_repeat_count 1.
    await f.step();
    const failed = (await f.store.listRuns(id)).find((r) => r.status === "failed");
    expect(failed?.outcome).toMatchObject({ status: "failed", error_code: "invalid_output" });
    await f.controller.tickAlarms();
    await f.controller.tickAlarms();
    // Auto mode goes on: no stop alert, no settings row by system:auto.
    expect((await f.modeRows()).map((r) => [r.new_value, r.actor])).toEqual([['"auto"', ME]]);
    expect((await f.store.listAlerts({ limit: 10 })).some((a) => a.pattern === "auto_stopped")).toBe(false);
    expect(await lastAutoStop(f.store)).toBeNull();
    // The alarm shows as open.
    expect((await openAlarms(f.store, f.clock.now())).map((a) => [a.pattern, a.error_code])).toContainEqual(["repeated_error", "invalid_output"]);
    // The failing item is held for a person: its queued runs are not claimed.
    expect(await f.store.getWorkItem(id)).toMatchObject({ blocked_on: "human", blocked_reason: RECURRING_FAILURE });
    await f.store.enqueueRun({ work_item_id: id, kind: "triage", idempotency_key: "after-hold" });
    expect(await f.store.claimRun({ worker_id: "w9" as WorkerId, kinds: ["triage"], lease_ms: 60_000 })).toBeNull();
  });

  it("a child crash loop still sets the mode to manual, once, however often the alarm step runs", async () => {
    let restarts: ChildRestart[] = [];
    const f = await autoFactory({ restarts: async () => restarts });
    await f.mode("auto");
    const now = f.clock.now().getTime();
    restarts = Array.from({ length: 5 }, (_, i) => ({ at: new Date(now - i * 60_000).toISOString(), reason: `exit ${i}` }));
    await f.controller.tickAlarms();
    await f.controller.tickAlarms();
    await stopped(f, "failure_alert");
    expect(await lastAutoStop(f.store)).toMatchObject({ cause: "failure_alert" });
  });

  it("a stop whose settings write failed after its alert: the next stop sets manual, not one 6 h later", async () => {
    const budgets = { 2: 20 };
    const f = await autoFactory({ config: { settings: { ...config.settings, defaults: { ...config.settings.defaults, budgets } } } });
    await f.mode("auto");
    const write = f.store.setSettingOverride.bind(f.store);
    let failed = false;
    f.store.setSettingOverride = async (o) => {
      if (o.actor === AUTO_ACTOR && !failed) {
        failed = true;
        throw new Error("store down");
      }
      return write(o);
    };
    const first = await f.create();
    await f.step();
    await f.approveRun(first).catch(() => undefined);
    expect(failed).toBe(true);
    expect(await f.modeRows()).toHaveLength(1);
    // The alert is recorded and deduped for 6 h; a second checkpoint's stop finds the mode still auto and sets it.
    const second = await f.create();
    await f.step();
    await f.approveRun(second);
    await stopped(f, "budget_checkpoint");
  });

  it("a budget checkpoint sets the mode to manual", async () => {
    const budgets = { 2: 20 };
    const f = await autoFactory({ config: { settings: { ...config.settings, defaults: { ...config.settings.defaults, budgets } } } });
    await f.mode("auto");
    const id = await f.create();
    await f.step();
    await f.approveRun(id);
    expect(await f.store.getWorkItem(id)).toMatchObject({ blocked_on: "budget", blocked_reason: "budget_checkpoint" });
    await stopped(f, "budget_checkpoint");
  });

  it("in manual mode a stop condition writes nothing", async () => {
    const f = await autoFactory({ spec: { tier: 9 } });
    await f.setting("alarm_repeat_count", 1);
    await f.create();
    await f.step();
    await f.controller.tickAlarms();
    expect(await f.modeRows()).toEqual([]);
    expect((await f.store.listAlerts({ limit: 10 })).some((a) => a.pattern === "auto_stopped")).toBe(false);
  });
});
