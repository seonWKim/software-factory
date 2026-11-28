import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { WorkItemId } from "../src/core/types.js";
import type { FakeClock } from "../src/impl/clock/fake-clock.js";
import type { NoOpSandbox } from "../src/impl/sandbox/noop-sandbox.js";
import type { Sandbox } from "../src/interfaces/sandbox.js";
import { AUTO, ME, type Opts, UI_CHANGE, autoFactory, commitIn, git, stopped, uiAfterMerge } from "./helpers/classifier.js";

describe("auto mode: red main reverts a bad automatic merge", { timeout: 60_000 }, () => {
  // The UI check fails on a tree holding BROKEN, except on the merge check's merged commit. Each change touches a UI
  // path (web/app.css), so the merge check runs the UI check and passes, the change lands, and the red-main check on
  // the new base tip, whose change touches that path too, runs it and fails. The first item's change is clean, so its
  // check passes and stores the green base the second item's merge lands on.
  const FAILING = "FAIL  tests/broken.test.ts > is green";
  const uiCheck = (flag = "/nonexistent") => ({
    command: uiAfterMerge(`if git grep -q BROKEN || test -f ${flag}; then echo '${FAILING}'; exit 1; fi`), paths: ["web/"],
  });
  const brokenSecond = (n: number) => (n === 2 ? "BROKEN\n" : `changed ${n}\n`);
  const alerts = async (f: Awaited<ReturnType<typeof autoFactory>>, pattern: string) =>
    (await f.store.listAlerts({ limit: 50 })).filter((a) => a.pattern === pattern);
  const fixItems = async (f: Awaited<ReturnType<typeof autoFactory>>) =>
    (await f.store.db.all("SELECT intent_key FROM outbound_actions WHERE action = 'file_fix_item'")).map((r) => String(r.intent_key));

  /** Auto mode with the tier allowed; the first item merges green. Returns the green base. */
  async function greenFirst(f: Awaited<ReturnType<typeof autoFactory>>): Promise<string> {
    await f.setting("auto_merge_max_tier", 3);
    await f.mode("auto");
    const first = await f.create();
    await f.step();
    await f.approveRun(first);
    expect(await f.store.getWorkItem(first)).toMatchObject({ stage: "CLOSED", close_reason: "completed" });
    expect(await alerts(f, "red_main")).toEqual([]);
    return git(f.repo, "rev-parse", "main");
  }

  /** The second item through auto mode up to its merge; returns its id and the merge commit it landed as. */
  async function second(f: Awaited<ReturnType<typeof autoFactory>>): Promise<{ id: WorkItemId; merge: string }> {
    const id = await f.create();
    await f.step();
    await f.approveRun(id);
    const merged = (await f.changes(id)).find((c) => c.reason === "local_merged");
    expect(merged?.actor).toEqual(AUTO);
    return { id, merge: String(merged!.changes.merge_sha!.to) };
  }

  async function reverted(opts: Opts = {}) {
    const f = await autoFactory({ spec: UI_CHANGE, ui_check: uiCheck(), change: brokenSecond, ...opts });
    const green = await greenFirst(f);
    const { id, merge } = await second(f);
    return { f, green, id, merge, tip: git(f.repo, "rev-parse", "main") };
  }

  it("a change that breaks a check on the base is reverted: main is green again, the item is back at implement with the output, auto mode goes on", async () => {
    const { f, green, id, merge, tip } = await reverted();
    // The revert sits on the merge, with the green base's tree and git's own message.
    expect(git(f.repo, "rev-parse", "main^1")).toBe(merge);
    expect(git(f.repo, "rev-parse", "main^{tree}")).toBe(git(f.repo, "rev-parse", `${green}^{tree}`));
    expect(git(f.repo, "show", "-s", "--format=%B", "main")).toContain(`This reverts commit ${merge}, reversing\nchanges made to ${green}.`);
    // The item is reopened at implement as a loop, with the failing output in the stored detail.
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "RUNNING", loop_count: 1, merge_sha: null, close_reason: null });
    const loop = (await f.changes(id)).find((c) => c.reason === "merge_check_failed")!;
    expect(loop.detail).toMatchObject({
      reverted: true, merge_sha: merge, revert_sha: tip, failing_tests: JSON.stringify(["tests/broken.test.ts > is green"]), output_tail: `${FAILING}\n`,
    });
    // Its branch holds the change again on top of the revert, so the next attempt lands it.
    const branch = `${f.cfg.branch_prefix}${id}`;
    expect(git(f.repo, "rev-parse", `${branch}^1`)).toBe(tip);
    expect(git(f.repo, "rev-parse", `${branch}^{tree}`)).toBe(git(f.repo, "rev-parse", `${merge}^{tree}`));
    // Still auto: one red_main alert on the merge that says it was reverted, no fix item, no stop.
    expect((await f.modeRows()).map((r) => r.new_value)).toEqual(['"auto"']);
    expect(await alerts(f, "auto_stopped")).toEqual([]);
    const red = await alerts(f, "red_main");
    expect(red.map((a) => a.pattern_key)).toEqual([`red_main:${merge}`]);
    expect(JSON.parse(red[0]!.detail!).text).toContain(`the factory reverted the merge of ${id}`);
    expect(await fixItems(f)).toEqual([]);
    // The revert tracking records it on the item as any revert.
    const marks = (await f.changes(id)).filter((c) => c.reason === "reverted");
    expect(marks.map((c) => c.detail?.reverting_commit)).toEqual([tip]);
    expect((await f.store.listVerdicts(id)).filter((v) => v.verdict === "reverted").map((v) => v.reason)).toEqual([`reverted by commit ${tip}`]);
  });

  it("a second run for the same merge (another replica) changes nothing and adds no loop", async () => {
    const { f, id, merge, tip } = await reverted();
    const before = { item: await f.store.getWorkItem(id), changes: await f.changes(id), alerts: await f.store.listAlerts({ limit: 50 }), modes: await f.modeRows() };
    const atMerge = { ...before.item!, stage: "CLOSED" as const, close_reason: "completed" as const, merge_sha: merge };
    await (await f.controller.unit("local-merge")).redMainCheck(atMerge);
    expect(git(f.repo, "rev-parse", "main")).toBe(tip);
    expect(await f.store.getWorkItem(id)).toEqual(before.item);
    expect(await f.changes(id)).toEqual(before.changes);
    expect(await f.store.listAlerts({ limit: 50 })).toEqual(before.alerts);
    expect(await f.modeRows()).toEqual(before.modes);
  });

  it("at max_loops the reverted item waits on a person instead of a new implement run", async () => {
    const { f, id, merge, tip } = await reverted({ config: { max_loops: 1 } });
    expect(git(f.repo, "rev-parse", "main^1")).toBe(merge);
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "REVIEW", blocked_on: "human", blocked_reason: "max_loops", loop_count: 0, merge_sha: null });
    expect((await f.changes(id)).find((c) => c.reason === "max_loops")?.detail).toMatchObject({ reverted: true, revert_sha: tip });
    expect((await f.store.listRuns(id)).some((r) => r.kind === "implement" && r.idempotency_key.includes(":l1:"))).toBe(false);
    expect((await f.modeRows()).map((r) => r.new_value)).toEqual(['"auto"']);
  });

  it("when the checks still fail after the revert, auto mode goes back to manual, red main is raised and the revert stays", async () => {
    const flag = join(mkdtempSync(join(tmpdir(), "sf-flag-")), "red");
    // The base turns red by itself as the revert lands: the re-run fails on the reverted tip too.
    const redAfterRevert = (s: NoOpSandbox): Sandbox => new Proxy(s, {
      get: (t, k) => (k === "revertLocal"
        ? async (...a: Parameters<NoOpSandbox["revertLocal"]>) => {
          const r = await t.revertLocal(...a);
          writeFileSync(flag, "");
          return r;
        }
        : Reflect.get(t, k, t)),
    });
    const { f, merge, tip, id } = await reverted({ ui_check: uiCheck(flag), controllerSandbox: redAfterRevert });
    expect(git(f.repo, "rev-parse", "main^1")).toBe(merge);
    expect(git(f.repo, "show", "-s", "--format=%B", "main")).toContain(`This reverts commit ${merge}`);
    await stopped(f, "red_main");
    expect((await alerts(f, "red_main")).map((a) => a.pattern_key)).toEqual([`red_main:${tip}`]);
    expect(await fixItems(f)).toEqual([`file_fix_item:red_main:${tip}`]);
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "RUNNING", loop_count: 1 });
  });

  it("a base that was already red before the automatic merge is not blamed on it: no revert, the item stays merged, auto mode stops", async () => {
    const f = await autoFactory({ spec: UI_CHANGE, ui_check: uiCheck(), change: (n) => `changed ${n}\n` });
    await greenFirst(f);
    // A person's commit on main breaks the check after the green base was stored.
    git(f.repo, "checkout", "--quiet", "main");
    commitIn(f.repo, { "notes/red.md": "BROKEN\n" }, "red by hand");
    git(f.repo, "checkout", "--quiet", "work");
    const { id, merge } = await second(f);
    expect(git(f.repo, "rev-parse", "main")).toBe(merge);
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "CLOSED", close_reason: "completed", merge_sha: merge, loop_count: 0 });
    expect((await f.changes(id)).map((c) => c.reason)).not.toContain("merge_check_failed");
    await stopped(f, "red_main");
    expect((await alerts(f, "red_main")).map((a) => a.pattern_key)).toEqual([`red_main:${merge}`]);
    expect(await fixItems(f)).toEqual([`file_fix_item:red_main:${merge}`]);
  });

  it("an automatic merge older than one hour is not reverted and takes the stop", async () => {
    let late = false;
    // The red-main check of the second merge starts 61 minutes after it landed.
    const aging = (s: NoOpSandbox, clock: FakeClock): Sandbox => new Proxy(s, {
      get: (t, k) => (k === "create"
        ? async (...a: Parameters<NoOpSandbox["create"]>) => {
          if (late) clock.advance(61 * 60_000);
          return t.create(...a);
        }
        : Reflect.get(t, k, t)),
    });
    const f = await autoFactory({ spec: UI_CHANGE, ui_check: uiCheck(), change: brokenSecond, controllerSandbox: aging });
    await greenFirst(f);
    late = true;
    const { id, merge } = await second(f);
    expect(git(f.repo, "rev-parse", "main")).toBe(merge);
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "CLOSED", merge_sha: merge, loop_count: 0 });
    await stopped(f, "red_main");
  });

  it("a merge made by a person is not reverted and takes the stop", async () => {
    const f = await autoFactory({ spec: UI_CHANGE, ui_check: uiCheck(), change: brokenSecond });
    await greenFirst(f);
    // The tier no longer merges by itself: a person merges the second change.
    await f.setting("auto_merge_max_tier", 0);
    const id = await f.create();
    await f.step();
    await f.approveRun(id);
    expect((await f.cli(ME, { action: "command", command: "merge", id, text: "" })).code).toBe(0);
    await f.step();
    const done = (await f.store.getWorkItem(id))!;
    expect(done).toMatchObject({ stage: "CLOSED", close_reason: "completed" });
    expect((await f.changes(id)).find((c) => c.reason === "local_merged")?.actor).toEqual({ kind: "user", id: ME });
    await (await f.controller.unit("local-merge")).redMainCheck(done);
    expect(git(f.repo, "rev-parse", "main")).toBe(done.merge_sha);
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "CLOSED", loop_count: 0 });
    await stopped(f, "red_main");
  });
});
