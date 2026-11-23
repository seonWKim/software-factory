import { describe, expect, it } from "vitest";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { CONTEXT_QUEUED_PATH, REVISE_APPLIED, REVISE_QUEUED, pendingRevises } from "../src/controller/units/commands/queued-revise.js";
import { AT_TRIAGE, addedContext } from "../src/core/attachments.js";
import { Worker } from "../src/worker/index.js";
import type { UserId, WorkerId } from "../src/core/types.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { newStore } from "./helpers/store.js";
import { FakeAuth, FakeRunner, FakeSandbox, MemoryStorage } from "./helpers/fakes/runner.js";
import { FakeBroker } from "./helpers/fakes/broker.js";
import { FakeForge } from "./helpers/fakes/forge.js";
import { FakeSource } from "./helpers/fakes/source.js";
import { alice, config, issueRef, prompts, silent, triageSpec } from "./helpers/fakes/config.js";

// Add context on a New or in-triage item (design 02-attachments): `/revise <text>` while the triage run is queued or
// running is stored as a `revise_queued` row with `at: triage`, the reply says it is queued, and the triage run's end
// starts exactly one more triage run, whose prompt has the filed text and the added text.

const SECRET = "known-secret-value-0123456789";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

async function newItem(n: number) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const source = new FakeSource();
  const broker = new FakeBroker();
  const forge = new FakeForge(source, broker.calls);
  const scanner = new PatternEgressScanner(async () => [SECRET]);
  const runner = new FakeRunner({ triage: () => ({ output: triageSpec }) });
  const controller = new ControllerRole({ store, source, forge, auth: new FakeAuth(), clock, config, log: silent, scanner, repeated_failure_rule: false });
  const other = new ControllerRole({ store, source, forge, auth: new FakeAuth(), clock, config, log: silent, scanner, repeated_failure_rule: false });
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox: new FakeSandbox(), runner, broker, storage: new MemoryStorage(), clock, config, prompts, log: silent, scanner,
    toolEnv: { PATH: "/usr/bin" }, awake: new NoKeepAwake(),
  });
  const src = issueRef(n);
  source.queue.push({ kind: "item_requested", source: src, requester: alice, title: "Add a scope gate", body: "FILED: check the scope in CI" });
  await controller.tickIntake();
  const id = (await store.getWorkItemBySource("github_issue", src.id))!.id;
  let c = 0;
  const revise = async (feedback: string) => {
    const comment_id = `${n}-context-${++c}`;
    source.queue.push({ kind: "revise_requested", source: src, comment_id, requester: alice, feedback });
    await controller.tickIntake();
    return comment_id;
  };
  const triageRuns = async () => (await store.listRuns(id)).filter((r) => r.kind === "triage");
  const refusals = () => source.comments.filter((x) => x.marker.startsWith("<!-- factory:refused:"));
  const step = async () => {
    await controller.tickIntake();
    while (await worker.tick()) await controller.tickRuns();
    await controller.tickRuns();
  };
  return { store, source, runner, controller, other, worker, id, revise, triageRuns, refusals, step };
}

describe("add context on a New or in-triage item (design 02-attachments)", () => {
  it("is stored while the triage run is queued, the reply says queued, and the run's end starts exactly one re-triage", async () => {
    const f = await newItem(4101);
    expect(await f.store.getWorkItem(f.id)).toMatchObject({ stage: "NEW", blocked_on: "none" });
    const cid = await f.revise("ADDED: also cover the docs folder");
    expect(f.refusals()).toEqual([]);
    const row = (await f.store.listStateChanges(f.id)).find((x) => x.reason === REVISE_QUEUED)!;
    expect(row.detail).toEqual({ comment_id: cid, feedback: "ADDED: also cover the docs folder", at: AT_TRIAGE });
    expect(row.changes).toEqual({});
    const reply = f.source.comments.filter((x) => x.marker === `<!-- factory:revise-queued:${cid} -->`);
    expect(reply).toHaveLength(1);
    expect(reply[0]!.body).toContain(CONTEXT_QUEUED_PATH);
    // Added context is never implement feedback.
    expect(pendingRevises(await f.store.listStateChanges(f.id))).toEqual([]);
    expect(pendingRevises(await f.store.listStateChanges(f.id), AT_TRIAGE)).toEqual([{ comment_id: cid, feedback: "ADDED: also cover the docs folder" }]);

    // The triage run ends: two controllers apply it, and exactly one more triage run is queued; the item stays New.
    expect(await f.worker.tick()).toBe(true);
    await Promise.all([f.controller.tickRuns(), f.other.tickRuns()]);
    expect(await f.store.getWorkItem(f.id)).toMatchObject({ stage: "NEW", blocked_on: "none" });
    const applied = (await f.store.listStateChanges(f.id)).filter((x) => x.reason === REVISE_APPLIED);
    expect(applied.map((x) => x.detail)).toEqual([{ comment_ids: JSON.stringify([cid]), at: AT_TRIAGE }]);
    const keys = (await f.triageRuns()).map((r) => r.idempotency_key);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(`${f.id}:triage:l0:r0:context-${cid}`);

    // The re-triage reads the filed text and the added text, then the spec waits at the gate as usual.
    await f.step();
    const prompt = f.runner.specs.filter((s) => s.role === "triage").at(-1)!.prompt;
    expect(prompt).toContain("FILED: check the scope in CI");
    expect(prompt).toContain("## Added context (untrusted)");
    expect(prompt).toContain("ADDED: also cover the docs folder");
    expect(await f.store.getWorkItem(f.id)).toMatchObject({ stage: "READY", blocked_reason: "spec_pending" });
    expect((await f.triageRuns()).map((r) => r.idempotency_key)).toEqual(keys);
  });

  it("two contexts during one run: one re-triage that reads both, in order", async () => {
    const f = await newItem(4102);
    const first = await f.revise("first addition");
    const second = await f.revise("second addition");
    await f.step();
    expect((await f.store.listStateChanges(f.id)).filter((x) => x.reason === REVISE_APPLIED).map((x) => x.detail?.comment_ids)).toEqual([JSON.stringify([first, second])]);
    expect(await f.triageRuns()).toHaveLength(2);
    const prompt = f.runner.specs.filter((s) => s.role === "triage").at(-1)!.prompt;
    expect(prompt.indexOf("first addition")).toBeGreaterThan(-1);
    expect(prompt.indexOf("second addition")).toBeGreaterThan(prompt.indexOf("first addition"));
    expect(addedContext(await f.store.listStateChanges(f.id))).toEqual(["first addition", "second addition"]);
  });

  it("with empty text or text the leak scanner flags: the existing refusal, and nothing is stored", async () => {
    const f = await newItem(4103);
    await f.revise("   ");
    await f.revise(`the token is ${SECRET}`);
    expect(f.refusals().map((x) => x.body)).toEqual([
      expect.stringContaining("it needs feedback after the command, e.g. `/revise keep the existing CLI flag`"),
      expect.stringContaining("the feedback was blocked by the leak scanner"),
    ]);
    expect((await f.store.listStateChanges(f.id)).some((x) => x.reason === REVISE_QUEUED)).toBe(false);
    await f.step();
    expect(await f.triageRuns()).toHaveLength(1);
    expect(await f.store.getWorkItem(f.id)).toMatchObject({ stage: "READY", blocked_reason: "spec_pending" });
  });

  it("a paragraph and an image added to a New item: the next triage sees both, the image as image input", async () => {
    const f = await newItem(4104);
    const at = (await f.store.addAttachment({
      id: "at_1", work_item_id: f.id, kind: "image", media_type: "image/png", data: Buffer.from(PNG).toString("base64"), size_bytes: PNG.length,
      name: "screen.png", url: null, label: null, created_by: "local:me" as UserId,
    }))!;
    await f.store.addAttachment({ id: "at_2", work_item_id: f.id, kind: "link", media_type: null, data: null, size_bytes: null, name: null, url: "https://example.com/video", label: "the video", created_by: "local:me" as UserId });
    await f.revise("match the screenshot");
    await f.step();
    const spec = f.runner.specs.filter((s) => s.role === "triage").at(-1)!;
    expect(spec.prompt).toContain("match the screenshot");
    expect(spec.prompt).toContain("## Attachments");
    expect(spec.prompt).toContain("Untrusted material");
    expect(spec.prompt).toContain("link https://example.com/video (the video)");
    expect(spec.prompt).toContain("image screen.png (image/png");
    expect(spec.images).toEqual([{ media_type: "image/png", data: at.data }]);
  });
});
