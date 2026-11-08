import { describe, expect, it } from "vitest";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { Worker } from "../src/worker/index.js";
import type { WorkerId } from "../src/core/types.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import type { RunPassportIssuer, RunPassportRequest } from "../src/interfaces/tool-broker.js";
import { newStore } from "./helpers/store.js";
import { FakeAuth, FakeBroker, FakeForge, FakeRunner, FakeSandbox, FakeSource, MemoryStorage, alice, config, issueRef, prompts, silent, triageSpec } from "./helpers/fakes.js";

// G2 (RFC 0015 §8, M9): the worker mints a run passport before a run's first broker call and forgets it when the run
// ends. Without `begin` the passport broker refuses every credentialed call; without `end` tokens pile up.

describe("run passports in the worker", () => {
  it("each run begins a passport for its run, kind, item and branch, and ends it", async () => {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const source = new FakeSource();
    const scanner = new PatternEgressScanner(async () => []);
    const controller = new ControllerRole({ store, source, forge: new FakeForge(source), auth: new FakeAuth(), clock, config, log: silent, scanner, repeated_failure_rule: false });
    const events: string[] = [];
    const begun: RunPassportRequest[] = [];
    const passports: RunPassportIssuer = {
      begin: async (req) => void (begun.push(req), events.push(`begin ${req.run}`)),
      end: (run) => void events.push(`end ${run}`),
    };
    const worker = new Worker({
      id: "w1" as WorkerId, store, sandbox: new FakeSandbox(), runner: new FakeRunner({ triage: () => ({ output: triageSpec }) }),
      broker: new FakeBroker(), storage: new MemoryStorage(), clock, config, prompts, log: silent, scanner,
      toolEnv: { PATH: "/usr/bin" }, awake: new NoKeepAwake(), passports,
    });
    source.queue.push({ kind: "item_requested", source: issueRef(7), requester: alice, title: "t", body: "b" });
    await controller.tickIntake();
    while (await worker.tick()) await controller.tickRuns();

    const item = (await store.getWorkItemBySource("github_issue", issueRef(7).id))!;
    const [triage] = await store.listRuns(item.id);
    expect(begun).toEqual([expect.objectContaining({ run: triage!.id, kind: "triage", item: item.id, project: item.project })]);
    expect(events).toEqual([`begin ${triage!.id}`, `end ${triage!.id}`]);
  });
});
