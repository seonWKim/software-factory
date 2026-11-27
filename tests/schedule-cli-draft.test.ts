// `factory schedule draft` and `improve` (src/core/schedule-draft.ts, design 08-schedules): a fake model, never a live one.

import { describe, expect, it } from "vitest";
import { parseLocalCliArgs } from "../src/core/local-cli.js";
import { machineZone } from "../src/core/schedule-draft.js";
import type { ScheduleStore } from "../src/core/schedule.js";
import type { UserId } from "../src/core/types.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import type { LLMProvider, LLMRequest, LLMResponse } from "../src/interfaces/llm-provider.js";
import { ADD, OWNER, setup, stored } from "./helpers/schedule-cli.js";

const WORDS = "review the design of software-factory every day at 9am";
const DRAFTED = { title: "Design review", cadence: "daily", spec: "09:00", zone: "", action: "feedback", text: "Read design-system/ and file a task per gap." };
const REVISED = "Read design-system/components.md and file a task for each page that departs from it.";

/** A fake model that answers every call with `answer` and counts the calls. */
function fakeModel(answer: Record<string, unknown>): LLMProvider & { calls: LLMRequest[] } {
  const calls: LLMRequest[] = [];
  return {
    calls,
    async complete(req): Promise<LLMResponse> {
      calls.push(req);
      return { text: JSON.stringify(answer), parsed: answer, stop_reason: "end", usage: { input_tokens: 1, output_tokens: 1, cost_usd: null } };
    },
  };
}

/** A y/N ask that answers `yes` and records each question, and the lines printed before it. */
function askSays(yes: boolean) {
  const asked: string[] = [], shownFirst: string[][] = [];
  return { asked, shownFirst, ask: async (shown: readonly string[], q: string) => (shownFirst.push([...shown]), asked.push(q), yes) };
}

async function drafting(answer: Record<string, unknown>, ask?: (shown: readonly string[], q: string) => Promise<boolean>) {
  const llm = fakeModel(answer);
  const s = await setup({ llm, scanner: new PatternEgressScanner(async () => []), ...(ask ? { ask } : {}) });
  return { ...s, llm };
}

describe("parsing `factory schedule draft` and `improve`", () => {
  it("reads the words or the ID, and --yes only as the last word", () => {
    expect(parseLocalCliArgs("schedule", ["draft", ...WORDS.split(" ")])).toEqual({ action: "schedule", command: { verb: "draft", words: WORDS, yes: false } });
    expect(parseLocalCliArgs("schedule", ["draft", "every", "day", "--yes"])).toEqual({ action: "schedule", command: { verb: "draft", words: "every day", yes: true } });
    expect(parseLocalCliArgs("schedule", ["improve", "sch_fb"])).toEqual({ action: "schedule", command: { verb: "improve", id: "sch_fb", yes: false } });
    expect(parseLocalCliArgs("schedule", ["improve", "sch_fb", "--yes"])).toEqual({ action: "schedule", command: { verb: "improve", id: "sch_fb", yes: true } });
    for (const args of [["draft"], ["draft", "--yes"], ["improve"], ["improve", "a", "b"], ["improve", "--yes"]]) {
      expect({ args, r: parseLocalCliArgs("schedule", args) }).toMatchObject({ r: { error: expect.any(String) } });
    }
  });
});

describe("factory schedule draft", () => {
  it("prints the proposal before it asks y/N; y adds it", async () => {
    const { asked, shownFirst, ask } = askSays(true);
    const { store, cli } = await drafting(DRAFTED, ask);
    const r = await cli(["draft", ...WORDS.split(" ")]);
    expect(r.code).toBe(0);
    expect(shownFirst).toEqual([expect.arrayContaining(["proposed sch_id", "  cadence: daily 09:00", `  zone: ${machineZone()}`, "  action: feedback", `  text: ${DRAFTED.text}`])]);
    expect(r.lines).not.toContain("proposed sch_id"); // printed once, before the question
    expect(r.lines.at(-1)).toMatch(/^added sch_id\tDesign review\t/);
    expect(asked).toEqual(["Add schedule sch_id?"]);
    expect(await store.listSchedules()).toEqual([
      expect.objectContaining({ id: "sch_id", created_by: OWNER, cadence: { kind: "daily", spec: "09:00" }, zone: machineZone(), action: expect.objectContaining({ kind: "feedback", settings: expect.objectContaining({ prompt: DRAFTED.text }) }) }),
    ]);
  });

  it("n, or no terminal without --yes, stores nothing", async () => {
    const n = askSays(false), no = await drafting(DRAFTED, n.ask);
    expect(await no.cli(["draft", ...WORDS.split(" ")])).toMatchObject({ code: 0, lines: ["nothing was stored"] });
    expect(n.shownFirst).toEqual([expect.arrayContaining(["proposed sch_id"])]);
    expect(await no.store.listSchedules()).toEqual([]);
    const tty = await drafting(DRAFTED);
    const r = await tty.cli(["draft", ...WORDS.split(" ")]);
    expect(r.code).toBe(1);
    expect(r.lines.at(-1)).toContain("no terminal to ask y/N");
    expect(await tty.store.listSchedules()).toEqual([]);
  });

  it("--yes adds it without asking", async () => {
    const { asked, ask } = askSays(false);
    const { store, cli } = await drafting(DRAFTED, ask);
    expect((await cli(["draft", ...WORDS.split(" "), "--yes"])).code).toBe(0);
    expect(asked).toEqual([]);
    expect((await store.listSchedules()).map((s) => s.id)).toEqual(["sch_id"]);
  });

  it("with no model configured, refuses and stores nothing", async () => {
    const { store, cli } = await setup({ llm: null, scanner: new PatternEgressScanner(async () => []), ask: askSays(true).ask });
    const r = await cli(["draft", "every", "day", "--yes"]);
    expect(r).toMatchObject({ code: 1, lines: [expect.stringContaining("no model is configured")] });
    expect(await store.listSchedules()).toEqual([]);
  });
});

describe("factory schedule improve", () => {
  async function improving(yes?: boolean) {
    const a = yes === undefined ? undefined : askSays(yes);
    const s = await drafting({ text: REVISED }, a?.ask);
    await s.cli([...ADD.map((w) => (w === "build" ? "feedback" : w)), "--body", "look at the design"]);
    return { ...s, asked: a?.asked ?? [], shownFirst: a?.shownFirst ?? [] };
  }
  const prompt = async (store: ScheduleStore) => (await stored(store))!.action!.settings.prompt;

  it("prints the old and new text before it asks y/N, and edits only on y", async () => {
    const yes = await improving(true);
    const r = await yes.cli(["improve", "sch_fb"]);
    expect(r.code).toBe(0);
    expect(yes.shownFirst).toEqual([["old:", "  look at the design", "new:", `  ${REVISED}`]]);
    expect(r.lines.at(-1)).toMatch(/^edited sch_fb\t/);
    expect(yes.asked).toEqual(["Write the new text to sch_fb?"]);
    expect(await prompt(yes.store)).toBe(REVISED);

    const no = await improving(false);
    expect(await no.cli(["improve", "sch_fb"])).toMatchObject({ code: 0, lines: ["nothing was stored"] });
    expect(no.shownFirst).toEqual([expect.arrayContaining(["old:", "new:"])]);
    expect(await prompt(no.store)).toBe("look at the design");

    const tty = await improving();
    expect((await tty.cli(["improve", "sch_fb"])).code).toBe(1);
    expect(await prompt(tty.store)).toBe("look at the design");
  });

  it("--yes edits without asking", async () => {
    const s = await improving(false);
    expect((await s.cli(["improve", "sch_fb", "--yes"])).code).toBe(0);
    expect(s.asked).toEqual([]);
    expect(await prompt(s.store)).toBe(REVISED);
  });
});

describe("schedule draft and improve are the owner's only", () => {
  it("anyone but the owner is refused before any model call, and nothing is stored", async () => {
    const { store, cli, llm } = await drafting(DRAFTED, askSays(true).ask);
    await cli(ADD);
    const before = await store.listSchedules();
    const other = "local:guest@example.com" as UserId;
    for (const args of [["draft", "every", "day", "--yes"], ["improve", "sch_fb", "--yes"]]) {
      expect({ args, r: await cli(args, other) }).toMatchObject({ r: { code: 1, lines: [expect.stringContaining("only the owner manages schedules")] } });
    }
    expect(llm.calls).toEqual([]);
    expect(await store.listSchedules()).toEqual(before);
  });
});
