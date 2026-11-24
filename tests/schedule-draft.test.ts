// Draft and improve a schedule with the configured model (design 08-schedules; src/core/schedule-draft.ts). A fake
// model stands in for plugins.llm: no test calls a live model. Neither function stores anything; each returns a
// proposal or a reason. The owner's words and the schedule's text are egress-scanned before the model call, the
// model's text before it is returned, and a finding names only its rule.

import { describe, expect, it } from "vitest";
import { createSchedule } from "../src/core/schedule.js";
import { NO_MODEL, draftSchedule, improveSchedule, machineZone } from "../src/core/schedule-draft.js";
import type { UserId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import type { LLMProvider, LLMRequest, LLMResponse } from "../src/interfaces/llm-provider.js";
import { newStore } from "./helpers/store.js";

const OWNER = "local:owner@example.com" as UserId;
const WORDS = "review the design of software-factory every day at 9am";
const SECRET = "ghp_" + "a".repeat(36);
const DRAFT = {
  title: "Design review", cadence: "daily", spec: "09:00", zone: "",
  action: "feedback", text: "Read design-system/ and docs/design/, and file a task for each gap you find.",
};

type Answer = Record<string, unknown> | "throw" | "refused" | "max_tokens" | "error" | { raw: string };

/** A fake model: answers each call with `answer` and records every request. */
class FakeLLM implements LLMProvider {
  requests: LLMRequest[] = [];
  constructor(private readonly answer: Answer) {}
  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.requests.push(req);
    const usage = { input_tokens: 1, output_tokens: 1, cost_usd: null };
    const a = this.answer;
    if (a === "throw") throw new Error("model unavailable");
    if (a === "refused" || a === "max_tokens" || a === "error") return { text: "", stop_reason: a, usage };
    if ("raw" in a) return { text: a.raw as string, stop_reason: "end", usage };
    return { text: JSON.stringify(a), parsed: a, stop_reason: "end", usage };
  }
}

async function setup(answer: Answer) {
  const clock = new FakeClock("2026-11-22T12:00:00.000Z");
  const { store } = await newStore(clock);
  const llm = new FakeLLM(answer);
  const deps = { llm, scanner: new PatternEgressScanner(async () => []), newId: () => "0f3a-9c", zone: "Asia/Seoul", store };
  return { store, llm, deps, clock };
}

describe("draftSchedule", () => {
  it("drafts the owner's words as daily 09:00 in the owner's zone, a feedback action naming design-system/, and stores nothing", async () => {
    const { store, llm, deps } = await setup(DRAFT);
    const r = await draftSchedule(WORDS, deps);
    expect(r).toEqual({
      ok: true,
      value: { id: "sch_0f3a9c", fields: { title: "Design review", cadence: "daily", spec: "09:00", zone: "Asia/Seoul", action: "feedback", body: DRAFT.text } },
    });
    if (r.ok) expect(r.value.fields.body).toContain("design-system/");
    expect(await store.listSchedules()).toEqual([]);
    // One standard call, JSON only, with the words fenced as untrusted data.
    expect(llm.requests).toHaveLength(1);
    const req = llm.requests[0]!;
    expect(req.model_class).toBe("standard");
    expect(req.output_schema).toBeDefined();
    expect(req.system).toContain("untrusted data");
    expect(req.system).toContain("Answer only with JSON");
    expect(req.messages[0]!.content).toContain("untrusted");
    expect(req.messages[0]!.content).toContain(WORDS);
  });

  it("takes the machine's zone when no owner zone is given, and a zone the words name", async () => {
    const plain = await setup(DRAFT);
    const { zone: _z, ...noZone } = plain.deps;
    expect(await draftSchedule(WORDS, noZone)).toMatchObject({ ok: true, value: { fields: { zone: machineZone() } } });
    const named = await setup({ ...DRAFT, zone: "Europe/Berlin" });
    expect(await draftSchedule(`${WORDS} Berlin time`, named.deps)).toMatchObject({ ok: true, value: { fields: { zone: "Europe/Berlin" } } });
    // A zone the words do not name is not taken: the owner's stays.
    expect(await draftSchedule(WORDS, named.deps)).toMatchObject({ ok: true, value: { fields: { zone: "Asia/Seoul" } } });
  });

  it("the words never choose the ID", async () => {
    const { deps } = await setup({ ...DRAFT, id: "sch_mine" });
    expect(await draftSchedule(`${WORDS}, id sch_mine`, deps)).toMatchObject({ ok: true, value: { id: "sch_0f3a9c" } });
  });

  it("with no model, or a failed call, returns a reason and writes nothing", async () => {
    const off = await setup(DRAFT);
    expect(await draftSchedule(WORDS, { ...off.deps, llm: null })).toEqual({ ok: false, reason: NO_MODEL });
    const cases: [Answer, RegExp][] = [
      ["throw", /model call failed/], ["error", /model call failed/], ["refused", /refused/], ["max_tokens", /cut off/],
      [{ raw: "daily at nine, I think" }, /not the JSON asked for/], [{ title: "x" }, /not the JSON asked for/],
    ];
    for (const [answer, reason] of cases) {
      const { store, deps } = await setup(answer);
      expect({ answer, r: await draftSchedule(WORDS, deps) }).toMatchObject({ r: { ok: false, reason: expect.stringMatching(reason) } });
      expect(await store.listSchedules()).toEqual([]);
    }
  });

  it("refuses a proposal the cadence, zone or action checks refuse, with that reason", async () => {
    const cases: [Record<string, unknown>, string, RegExp][] = [
      [{ ...DRAFT, spec: "9am" }, WORDS, /refused: .*/],
      [{ ...DRAFT, cadence: "hourly" }, WORDS, /"hourly" is not a cadence/],
      [{ ...DRAFT, zone: "Mars/Olympus" }, `${WORDS} Mars/Olympus`, /"Mars\/Olympus" is not a time zone/],
      [{ ...DRAFT, action: "deploy" }, WORDS, /deploy/],
    ];
    for (const [answer, words, reason] of cases) {
      const { store, deps } = await setup(answer);
      const r = await draftSchedule(words, deps);
      expect({ answer, r }).toMatchObject({ r: { ok: false, reason: expect.stringMatching(reason) } });
      expect(r).toMatchObject({ reason: expect.stringContaining("the model's proposal was refused") });
      expect(await store.listSchedules()).toEqual([]);
    }
  });

  it("scans the words before the model call and the model's text before it is returned; a finding names only the rule", async () => {
    const words = await setup(DRAFT);
    const r = await draftSchedule(`${WORDS} with token ${SECRET}`, words.deps);
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("rule github_token") });
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(words.llm.requests).toEqual([]);

    const answer = await setup({ ...DRAFT, text: `Use ${SECRET} to read design-system/` });
    const out = await draftSchedule(WORDS, answer.deps);
    expect(out).toEqual({ ok: false, reason: expect.stringContaining("rule github_token") });
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(await answer.store.listSchedules()).toEqual([]);
  });

  it("scans every field the model wrote before the checks, whose refusals would quote it", async () => {
    const fields: Record<string, unknown>[] = [
      { ...DRAFT, cadence: SECRET }, { ...DRAFT, spec: SECRET }, { ...DRAFT, zone: SECRET },
      { ...DRAFT, action: SECRET }, { ...DRAFT, title: SECRET },
    ];
    for (const answer of fields) {
      const { store, deps } = await setup(answer);
      const r = await draftSchedule(WORDS, deps);
      expect({ answer, r }).toMatchObject({ r: { ok: false, reason: expect.stringContaining("rule github_token") } });
      expect(JSON.stringify(r)).not.toContain(SECRET);
      expect(await store.listSchedules()).toEqual([]);
    }
  });
});

describe("improveSchedule", () => {
  async function withSchedule(answer: Answer, prompt = "look at the design") {
    const s = await setup(answer);
    const r = await createSchedule(s.store, "sch_fb", { title: "Design", cadence: "daily", spec: "09:00", zone: "UTC", action: "feedback", body: prompt }, OWNER, s.clock.now());
    if (!r.ok) throw new Error(r.problem);
    return { ...s, before: await s.store.listSchedules() };
  }

  it("returns the old and a revised instruction and stores nothing", async () => {
    const revised = "Read design-system/components.md and design-system/patterns.md; file a task for each page that departs from them.";
    const { store, llm, deps, before } = await withSchedule({ text: revised });
    expect(await improveSchedule("sch_fb", deps)).toEqual({ ok: true, value: { id: "sch_fb", old: "look at the design", new: revised } });
    expect(await store.listSchedules()).toEqual(before);
    const req = llm.requests[0]!;
    expect(req.model_class).toBe("standard");
    expect(req.system).toContain("untrusted data");
    expect(req.messages[0]!.content).toContain("untrusted");
    expect(req.messages[0]!.content).toContain("look at the design");
  });

  it("refuses an unknown schedule, no model, or a failed call, and writes nothing", async () => {
    const off = await withSchedule({ text: "x" });
    expect(await improveSchedule("sch_fb", { ...off.deps, llm: null })).toEqual({ ok: false, reason: NO_MODEL });
    expect(await improveSchedule("sch_none", off.deps)).toEqual({ ok: false, reason: "no schedule sch_none" });
    for (const [answer, reason] of [["throw", /failed/], ["refused", /refused/], ["max_tokens", /cut off/], [{ raw: "better text" }, /JSON/], [{ text: "" }, /JSON/]] as [Answer, RegExp][]) {
      const { store, deps, before } = await withSchedule(answer);
      expect({ answer, r: await improveSchedule("sch_fb", deps) }).toMatchObject({ r: { ok: false, reason: expect.stringMatching(reason) } });
      expect(await store.listSchedules()).toEqual(before);
    }
  });

  it("scans the schedule's text before the call and the answer after; a finding names only the rule", async () => {
    const dirty = await withSchedule({ text: "fine" }, `look with ${SECRET}`);
    const r = await improveSchedule("sch_fb", dirty.deps);
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("rule github_token") });
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(dirty.llm.requests).toEqual([]);
    const leak = await withSchedule({ text: `use ${SECRET}` });
    const out = await improveSchedule("sch_fb", leak.deps);
    expect(out).toEqual({ ok: false, reason: expect.stringContaining("rule github_token") });
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });
});
