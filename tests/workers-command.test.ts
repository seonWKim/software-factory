import { describe, expect, it } from "vitest";
import type { UserId, WorkerId } from "../src/core/types.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { WORKERS_USAGE, parseWorkersArgs, runWorkersCommand } from "../src/worker/index.js";
import { issue, newStore, system } from "./helpers/store.js";

const ME = "local:me@example.com" as UserId;

// `factory workers pause <n> | pause --all | resume | status` (design §5 Pause).

describe("workers command: arguments", () => {
  it("parses pause <n>, pause --all, resume and status", () => {
    expect(parseWorkersArgs(["pause", "2"])).toEqual({ op: "pause", count: 2 });
    expect(parseWorkersArgs(["pause", "--all"])).toEqual({ op: "pause_all" });
    expect(parseWorkersArgs(["resume"])).toEqual({ op: "resume" });
    expect(parseWorkersArgs(["status"])).toEqual({ op: "status" });
    expect(parseWorkersArgs([])).toEqual({ op: "status" });
  });

  it("refuses anything else with the usage, --by included (the actor is the CLI identity)", () => {
    for (const bad of [["pause"], ["pause", "0"], ["pause", "-1"], ["pause", "two"], ["pause", "2", "3"], ["resume", "now"], ["stop"]]) {
      expect(parseWorkersArgs(bad)).toEqual({ error: WORKERS_USAGE });
    }
    for (const bad of [["pause", "3", "--by", "github:12345"], ["--by", "github:1", "pause", "--all"], ["pause", "1", "--by"]]) {
      expect(parseWorkersArgs(bad)).toEqual({ error: WORKERS_USAGE });
    }
    expect(WORKERS_USAGE).not.toContain("--by");
  });
});

describe("workers command: effects", () => {
  const run = (store: FactoryStore, action: Parameters<typeof runWorkersCommand>[1]) => runWorkersCommand({ store, actor: ME, refusal: async () => null }, action);

  it("pause <n> pauses the workers whose runs started last, status lists them, resume clears every pause", async () => {
    const { store, clock } = await newStore();
    for (let i = 1; i <= 3; i++) {
      await store.createWorkItem(issue(i), system, { enqueue: { kind: "implement", idempotency_key: `i${i}` } });
      clock.advance(1);
      await store.claimRun({ worker_id: `h:1:${i}` as WorkerId, kinds: ["implement"], lease_ms: 60_000 });
    }
    const out = await run(store, { op: "pause", count: 2 });
    expect(out).toMatchObject({ code: 0, lines: ["paused 2 workers: h:1:3, h:1:2", expect.any(String)] });
    // The actor is the CLI identity's user.
    expect((await run(store, { op: "status" })).lines).toEqual([
      expect.stringMatching(new RegExp(`^h:1:\\d paused by ${ME} since `)),
      expect.stringMatching(new RegExp(`^h:1:\\d paused by ${ME} since `)),
    ]);
    // Asking for more than are running says so.
    expect((await run(store, { op: "pause", count: 5 })).lines).toEqual([
      "paused 1 worker: h:1:1",
      "only 1 unpaused worker has a run in progress",
      expect.stringContaining("factory workers resume"),
    ]);
    expect((await run(store, { op: "pause", count: 1 })).lines).toEqual(["paused no worker: no unpaused worker has a run in progress"]);
    expect((await run(store, { op: "pause_all" })).lines).toEqual([
      "paused every worker loop, idle ones included",
      expect.stringContaining("nothing pushed"),
    ]);
    expect((await store.listWorkerPauses()).map((p) => p.paused_by)).toContain(ME);
    expect(await run(store, { op: "resume" })).toEqual({ code: 0, lines: ["cleared 4 pauses: workers claim again, paused runs resume"] });
    expect((await run(store, { op: "status" })).lines).toEqual(["no worker is paused"]);
    expect((await run(store, { op: "resume" })).lines).toEqual(["no pause was in force"]);
  });
});

describe("workers command: the owner check (approve_spec)", () => {
  it("asks the check before pause, pause --all and resume; a refusal exits 1 and writes nothing; status needs no check", async () => {
    const { store } = await newStore();
    const asked: string[] = [];
    const refusing = { store, actor: "local:other" as UserId, refusal: async () => (asked.push("ask"), "not_owner") };
    for (const action of [{ op: "pause", count: 1 }, { op: "pause_all" }] as const) {
      expect(await runWorkersCommand(refusing, action)).toEqual({ code: 1, lines: ["not changed: not_owner"] });
    }
    expect(await store.listWorkerPauses()).toEqual([]);
    await store.pauseWorkers({ all: true }, ME);
    expect(await runWorkersCommand(refusing, { op: "resume" })).toEqual({ code: 1, lines: ["not changed: not_owner"] });
    expect(await store.listWorkerPauses()).toEqual([expect.objectContaining({ worker_id: "*", paused_by: ME })]);
    expect(asked).toHaveLength(3);
    expect((await runWorkersCommand(refusing, { op: "status" })).code).toBe(0);
    expect(asked).toHaveLength(3);
  });
});
