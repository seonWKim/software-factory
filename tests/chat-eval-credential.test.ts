// The daily chat eval run waits on the model credential (design 04-chat-agent, issue #915): while none is saved the
// controller's chat-eval unit claims no day, starts no run and stores no chat_eval_failed alert; the first poll after
// one is saved runs the day. Fake kernel and a real store cursor; no model is called.

import { describe, expect, it } from "vitest";
import { CHAT_EVAL_CURSOR, type ChatEvalDeps, chatEvalSchedule } from "../src/core/chat-eval.js";
import { ChatEvalUnit } from "../src/controller/units/chat-eval/chat-eval.unit.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { newStore } from "./helpers/store.js";

type Ctx = ConstructorParameters<typeof ChatEvalUnit>[0];

/** The unit on a fake kernel whose `alert` writes go to `store`; every log message is kept. */
function unit(port: NonNullable<Ctx["k"]["d"]["chat_eval"]>, now: { ms: number }, store: FactoryStore) {
  const logs: string[] = [];
  const log = { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m), debug: () => {} };
  const reader = { scan: async () => ({ clean: true }) };
  const commit = async (b: { writes: { kind: string; alert: Parameters<FactoryStore["recordAlert"]>[0]; dedupe_ms: number }[] }) => {
    for (const w of b.writes) if (w.kind === "alert") await store.recordAlert(w.alert, w.dedupe_ms);
  };
  const ctx = { k: { d: { chat_eval: port, log }, nowMs: () => now.ms, reader, commit } } as unknown as Ctx;
  return { u: new ChatEvalUnit(ctx), logs };
}

describe("chat eval and the model credential", () => {
  it("starts no run and stores no alert while no model credential is saved, then runs the day on the first poll after one is saved", async () => {
    const { store } = await newStore();
    const state = { saved: false, runs: 0 };
    const schedule = chatEvalSchedule(store, {} as ChatEvalDeps, async () => "", async () => state.saved);
    // The run a missing credential would make: it throws at once, as the model call does.
    const port = {
      ...schedule,
      run: async () => {
        state.runs++;
        if (!state.saved) throw new Error("no model credential in the secret file");
        return { passed: 12, total: 12, bar: 8, ok: true };
      },
    };
    const now = { ms: Date.parse("2026-11-28T09:00:00Z") };
    const { u, logs } = unit(port, now, store);

    for (let i = 0; i < 3; i++) {
      await u.evalStep();
      await u.running;
      now.ms += 60_000;
    }
    expect(state.runs).toBe(0);
    expect(logs).not.toContain("chat eval run started");
    expect((await store.listAlerts({ limit: 100 })).some((a) => a.pattern === "chat_eval_failed")).toBe(false);
    expect(await store.getCursor(CHAT_EVAL_CURSOR)).toBeNull(); // no day used up

    state.saved = true;
    await u.evalStep();
    await u.running;
    expect(state.runs).toBe(1);
    expect(logs).toContain("chat eval run started");
    expect(logs).toContain("chat eval run finished");
    expect(await store.getCursor(CHAT_EVAL_CURSOR)).toBe("2026-11-28");
    expect((await store.listAlerts({ limit: 100 })).some((a) => a.pattern === "chat_eval_failed")).toBe(false);
  });

  it("a schedule built without a credential check claims as before", async () => {
    const { store } = await newStore();
    const schedule = chatEvalSchedule(store, {} as ChatEvalDeps, async () => "");
    expect(schedule.credentialSaved).toBeUndefined();
    expect(await schedule.claim("2026-11-28")).toBe(true);
  });
});
