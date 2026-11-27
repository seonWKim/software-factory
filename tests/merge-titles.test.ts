import { describe, expect, it } from "vitest";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { MISS_RETRY_MS, TITLE_FILLS } from "../src/controller/units/pr-events/pr-events.unit.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { FakeAuth } from "./helpers/fakes/runner.js";
import { FakeForge } from "./helpers/fakes/forge.js";
import { FakeSource } from "./helpers/fakes/source.js";
import { cleanScanner, config, recordingLog, waitFor } from "./helpers/fakes/config.js";
import { PROJECT_KEY, human, issue, newStore } from "./helpers/store.js";

// The title backfill of unreviewed merges recorded with none (design 09-dashboard-tasks-needs, 2026-11-26): the
// Worth sampling rows read "PR #436" until a title is stored.

/** A GitHub-like forge: it reads PR titles, from `titles`; a PR in `failing` throws. Every read is recorded. */
class TitledForge extends FakeForge {
  titles = new Map<number, string>();
  failing = new Set<number>();
  reads: number[] = [];
  async prTitle(pr: number): Promise<string | null> {
    this.reads.push(pr);
    if (this.failing.has(pr)) throw new Error("HTTP 502");
    return this.titles.get(pr) ?? null;
  }
}

async function factory(withForge: boolean) {
  const clock = new FakeClock("2026-11-26T00:00:00Z");
  const { store } = await newStore(clock);
  const log = recordingLog();
  const forge = new TitledForge();
  const controller = new ControllerRole({
    store, source: new FakeSource(), ...(withForge ? { forge } : {}), auth: new FakeAuth(), clock, config, log, scanner: cleanScanner,
  });
  const merge = (n: number) => store.recordUnreviewedMerge({ project: PROJECT_KEY, change_ref: String(n), merge_sha: `m${n}`, merger_id: null });
  const titles = async () => Object.fromEntries((await store.listUnreviewedMerges(100)).map((m) => [m.change_ref, m.title]));
  return { clock, store, log, forge, controller, merge, titles };
}

describe("unreviewed merge titles", () => {
  it("fills null titles from the matching work item, else the forge's PR title, and stores them", async () => {
    const f = await factory(true);
    await f.store.createWorkItem({ ...issue(60), title: "Speed up the poll", adopted: { change_ref: "60", head_branch: "feature/x", head_sha: "h", allowed_paths: ["a"], tier: 1 } }, human);
    f.forge.titles.set(436, "Show PR titles on the Tasks page");
    await f.merge(436);
    await f.merge(60);
    await f.controller.tickIntake();
    expect(await f.titles()).toEqual({ "436": "Show PR titles on the Tasks page", "60": "Speed up the poll" });
    expect(f.forge.reads).toEqual([436]); // the item's title, no forge read for #60
    await f.controller.tickIntake();
    expect(f.forge.reads).toEqual([436]); // stored: not read again
  });

  it("the running controller fills them in its poll steps, not only in a manual intake tick", async () => {
    const f = await factory(true);
    f.forge.titles.set(436, "Show PR titles on the Tasks page");
    await f.merge(436);
    const ac = new AbortController();
    const running = f.controller.run(ac.signal);
    await waitFor(async () => (await f.titles())["436"] !== null, "title filled");
    ac.abort();
    await running;
    expect(await f.titles()).toEqual({ "436": "Show PR titles on the Tasks page" });
  });

  it(`reads at most ${TITLE_FILLS} titles a pass, the rest on the next`, async () => {
    const f = await factory(true);
    for (let n = 1; n <= TITLE_FILLS + 5; n++) {
      f.forge.titles.set(n, `PR title ${n}`);
      await f.merge(n);
    }
    await f.controller.tickIntake();
    expect(f.forge.reads).toHaveLength(TITLE_FILLS);
    await f.controller.tickIntake();
    expect(f.forge.reads).toHaveLength(TITLE_FILLS + 5);
    expect(Object.values(await f.titles()).every((t) => t !== null)).toBe(true);
  });

  it("with no forge selected (the GitHub plugin off) reads nothing: a row with no item keeps no title", async () => {
    const f = await factory(false);
    await f.store.createWorkItem({ ...issue(61), title: "Local fix", adopted: { change_ref: "61", head_branch: "feature/y", head_sha: "h", allowed_paths: ["a"], tier: 1 } }, human);
    await f.merge(436);
    await f.merge(61);
    await f.controller.tickIntake();
    expect(f.forge.reads).toEqual([]);
    expect(await f.titles()).toEqual({ "436": null, "61": "Local fix" });
    expect(f.log.lines.filter((l) => l.level === "error")).toEqual([]);
  });

  it("a failed read is not retried on the next pass, only after the retry time", async () => {
    const f = await factory(true);
    f.forge.failing.add(7);
    await f.merge(7);
    await f.controller.tickIntake();
    await f.controller.tickIntake();
    expect(f.forge.reads).toEqual([7]);
    expect(await f.titles()).toEqual({ "7": null });

    f.forge.failing.clear();
    f.forge.titles.set(7, "Fix the flaky test");
    f.clock.advance(MISS_RETRY_MS);
    await f.controller.tickIntake();
    expect(f.forge.reads).toEqual([7, 7]);
    expect(await f.titles()).toEqual({ "7": "Fix the flaky test" });
  });
});
