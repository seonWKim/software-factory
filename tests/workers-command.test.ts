import { describe, expect, it } from "vitest";
import type { WorkerId } from "../src/core/types.js";
import { WORKERS_CLI_ACTOR, WORKERS_USAGE, parseWorkersArgs, runWorkersCommand } from "../src/core/worker-pool.js";
import { issue, newStore, system } from "./helpers/store.js";

// `factory workers pause <n> | pause --all | resume | status` (design §5 Pause).

describe("workers command: arguments", () => {
  it("parses pause <n>, pause --all, resume and status, with an optional --by ID", () => {
    expect(parseWorkersArgs(["pause", "2"])).toEqual({ op: "pause", count: 2, by: WORKERS_CLI_ACTOR });
    expect(parseWorkersArgs(["pause", "--all"])).toEqual({ op: "pause_all", by: WORKERS_CLI_ACTOR });
    expect(parseWorkersArgs(["pause", "3", "--by", "github:12345"])).toEqual({ op: "pause", count: 3, by: "github:12345" });
    expect(parseWorkersArgs(["--by", "github:1", "pause", "--all"])).toEqual({ op: "pause_all", by: "github:1" });
    expect(parseWorkersArgs(["resume"])).toEqual({ op: "resume" });
    expect(parseWorkersArgs(["status"])).toEqual({ op: "status" });
    expect(parseWorkersArgs([])).toEqual({ op: "status" });
  });

  it("refuses anything else with the usage, and a --by that is not an ID", () => {
    for (const bad of [["pause"], ["pause", "0"], ["pause", "-1"], ["pause", "two"], ["pause", "2", "3"], ["resume", "now"], ["stop"]]) {
      expect(parseWorkersArgs(bad)).toEqual({ error: WORKERS_USAGE });
    }
    expect(parseWorkersArgs(["pause", "1", "--by"])).toMatchObject({ error: expect.stringContaining("--by") });
    expect(parseWorkersArgs(["pause", "1", "--by", "Alice Smith"])).toMatchObject({ error: expect.stringContaining("--by") });
  });
});

describe("workers command: effects", () => {
  it("pause <n> pauses the workers whose runs started last, status lists them, resume clears every pause", async () => {
    const { store, clock } = await newStore();
    for (let i = 1; i <= 3; i++) {
      await store.createWorkItem(issue(i), system, { enqueue: { kind: "implement", idempotency_key: `i${i}` } });
      clock.advance(1);
      await store.claimRun({ worker_id: `h:1:${i}` as WorkerId, kinds: ["implement"], lease_ms: 60_000 });
    }
    const out = await runWorkersCommand(store, { op: "pause", count: 2, by: "github:7" });
    expect(out[0]).toBe("paused 2 workers: h:1:3, h:1:2");
    expect(await runWorkersCommand(store, { op: "status" })).toEqual([
      expect.stringMatching(/^h:1:\d paused by github:7 since /),
      expect.stringMatching(/^h:1:\d paused by github:7 since /),
    ]);
    // Asking for more than are running says so.
    expect(await runWorkersCommand(store, { op: "pause", count: 5, by: "github:7" })).toEqual([
      "paused 1 worker: h:1:1",
      "only 1 unpaused worker has a run in progress",
      expect.stringContaining("factory workers resume"),
    ]);
    expect(await runWorkersCommand(store, { op: "pause", count: 1, by: "github:7" })).toEqual(["paused no worker: no unpaused worker has a run in progress"]);
    expect(await runWorkersCommand(store, { op: "pause_all", by: "github:7" })).toEqual([
      "paused every worker loop, idle ones included",
      expect.stringContaining("nothing pushed"),
    ]);
    expect(await runWorkersCommand(store, { op: "resume" })).toEqual(["cleared 4 pauses: workers claim again, paused runs resume"]);
    expect(await runWorkersCommand(store, { op: "status" })).toEqual(["no worker is paused"]);
    expect(await runWorkersCommand(store, { op: "resume" })).toEqual(["no pause was in force"]);
  });
});
