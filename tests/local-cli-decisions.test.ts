import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { type CliAction, type LocalCliDeps, runLocalCli } from "../src/core/local-cli.js";
import type { UserId, WorkItemId } from "../src/core/types.js";
import { OwnerAuth } from "../src/core/authorize.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { LocalSource } from "../src/impl/source/local-source.js";
import { cleanScanner, config, silent, triageSpec } from "./helpers/fakes/config.js";
import { PROJECT_KEY, newStore, w1 } from "./helpers/store.js";
import { splitAnswers, storedAnswers } from "../src/shared/command-notes.js";
import { answers, at, snapshot } from "./helpers/local-cli.js";

describe("approve answers the spec's decisions at intake (CLI)", () => {
  const ME = "local:me@example.com" as UserId;
  const DECISIONS = [
    { question: "Fail the job, or only warn?", reason: "A failing job blocks merges.", options: ["Fail the job", "Only warn"], default: "Fail the job", owner_only: false },
    { question: "Name the step?", reason: "It shows in CI.", options: [], default: "scope", owner_only: false },
    { question: "Who owns the gate?", reason: "Someone answers its alerts.", options: [], default: "", owner_only: true },
  ];

  /** A controller over local items, and the CLI as ME (the local owner once it writes). */
  async function harness() {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const controller = new ControllerRole({
      store, sources: [new LocalSource(store)], auth: new OwnerAuth(store), clock, config, log: silent, scanner: cleanScanner,
      repeated_failure_rule: false,
    });
    let n = 0;
    const d: LocalCliDeps = { store, identity: { user: ME, from: "git user.email" }, project: async () => PROJECT_KEY, read: async () => "b", newId: () => `id${++n}`, answers };
    const run = (a: CliAction) => runLocalCli(d, a);
    /** A local item whose triage run wrote a spec with `decisions`, waiting at the spec gate. */
    const triaged = async (decisions: unknown[] = DECISIONS): Promise<WorkItemId> => {
      const id = (await run({ action: "create", title: "t", bodyFile: "b" })).lines[0] as WorkItemId;
      const r = (await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: 60_000 }))!;
      await store.completeRun(r.id, r.lease!.token, { status: "succeeded", summary: "s", data: { spec: { ...triageSpec, decisions } } });
      clock.advance(1000);
      await controller.tickRuns();
      expect(await store.getWorkItem(id)).toMatchObject({ stage: "READY", blocked_reason: "spec_pending" });
      return id;
    };
    const approve = (id: WorkItemId, text: string) => run({ action: "command", command: "approve", id, text });
    const approval = async (id: WorkItemId) => (await store.listStateChanges(id)).find((c) => c.reason === "spec_approved");
    return { store, controller, triaged, approve, approval };
  }

  it("reproduces the report: `approve <id> \"1: X\"` stores X as decision 1's answer, not its default", async () => {
    const h = await harness();
    const id = await h.triaged();
    expect((await h.approve(id, "1: X")).code).toBe(0);
    await h.controller.tickCommands();
    expect(storedAnswers((await h.approval(id))?.detail ?? null)[0]).toEqual({ question: "Fail the job, or only warn?", answer: "X", accepted_default: false });
  });

  it("stores the same answers detail as the dashboard dialog's approve with the same note", async () => {
    const h = await harness();
    const byCli = await h.triaged();
    const byApp = await h.triaged();
    const note = "1: Only warn\nkeep it small";
    expect((await h.approve(byCli, note)).code).toBe(0);
    await h.store.recordAppCommandRequest({ key: "app-1", actor: ME, command: "approve", args: { work_item_id: byApp, note } });
    await h.controller.tickCommands();
    const cli = (await h.approval(byCli))!;
    const app = (await h.approval(byApp))!;
    expect(cli.detail?.answers).toBeDefined();
    expect(cli.detail?.answers).toBe(app.detail?.answers);
    expect(cli.detail?.note).toBe(app.detail?.note);
  });

  it("prints every decision after the stored line: numbered, its question, its answer and whose it is", async () => {
    const h = await harness();
    const id = await h.triaged();
    const r = await h.approve(id, "1: Only warn\n2: scope\nkeep it small");
    expect(r.code).toBe(0);
    expect(r.lines[0]).toContain(`stored \`/approve\` for ${id}`);
    expect(r.lines.slice(1)).toEqual([
      "1. Fail the job, or only warn? → Only warn (your answer)",
      "2. Name the step? → scope (default taken)",
      "3. Who owns the gate? → (no answer and no default)",
    ]);
    // The note is stored as typed; the controller parses it again on apply.
    expect((await h.store.listCliCommandsAfter(0, 10)).at(-1)).toMatchObject({ command: "approve", args: { item: id, text: "1: Only warn\n2: scope\nkeep it small" } });
  });

  it("with no N: line every default is printed as taken", async () => {
    const h = await harness();
    const id = await h.triaged();
    const r = await h.approve(id, "");
    expect(r.lines.slice(1)).toEqual([
      "1. Fail the job, or only warn? → Fail the job (default taken)",
      "2. Name the step? → scope (default taken)",
      "3. Who owns the gate? → (no answer and no default)",
    ]);
  });

  it("a line naming no decision, a repeated N or an empty answer exits 1 with the parser's refusal and stores nothing", async () => {
    const h = await harness();
    const id = await h.triaged();
    const before = await snapshot(h.store);
    for (const text of ["9: X", "1: a\n1: b", "2:   "]) {
      const refusal = splitAnswers(text, DECISIONS.map((x) => ({ text: x.question, default: x.default || null })));
      expect("refuse" in refusal).toBe(true);
      expect(await h.approve(id, text)).toEqual({ code: 1, lines: [(refusal as { refuse: string }).refuse] });
    }
    expect((await h.approve(id, "9: X")).lines[0]).toBe("`9:` names no decision: this spec has decisions 1 to 3, so nothing was stored");
    expect(await snapshot(h.store)).toEqual(before);
  });

  it("a spec with no decisions keeps today's behaviour: the note as typed, no decision lines", async () => {
    const h = await harness();
    const id = await h.triaged([]);
    const r = await h.approve(id, "1: a note");
    expect(r).toEqual({ code: 0, lines: [expect.stringContaining(`stored \`/approve\` for ${id}`)] });
    expect((await h.store.listCliCommandsAfter(0, 10)).at(-1)).toMatchObject({ command: "approve", args: { item: id, text: "1: a note" } });
  });

  it("the phase check runs before the parse: a closed item is refused with its text, whatever the lines", async () => {
    const h = await harness();
    const id = await h.triaged();
    await at(h.store, id, { stage: "CLOSED", close_reason: "completed" });
    expect(await h.approve(id, "9: X")).toEqual({ code: 1, lines: ["`/approve` was not applied: the work item is closed."] });
  });

  it("core has no copy of the answer-line parser or its refusals: it calls them through LocalCliDeps.answers", () => {
    const src = readFileSync(new URL("../src/core/local-cli.ts", import.meta.url), "utf8");
    for (const w of ["names no decision", "is answered twice", "is empty; write it", "(\\d+)\\s*:"]) expect({ w, copy: src.includes(w) }).toEqual({ w, copy: false });
    expect(src).toContain("d.answers.split(");
    expect(src).toContain("d.answers.detail(");
  });
});
