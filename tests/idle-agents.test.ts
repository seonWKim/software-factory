import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

// scripts/idle-agents/schedule.mjs: the idle-agent scheduler's pure helpers (a local development process). The
// clock is faked by passing `now`; the zone is passed so the test does not depend on the host's.
const schedule = (await import(pathToFileURL(join(import.meta.dirname, "..", "scripts", "idle-agents", "schedule.mjs")).href)) as {
  localDate(when: string | Date, timeZone?: string): string;
  isDue(lastRun: string | undefined, now: Date, timeZone?: string): boolean;
  pick(agents: string[], last: Record<string, string>, allowed: (a: string) => boolean, now: Date, timeZone?: string): string | null;
  countBrowserCalls(streamJson: string): number;
  describeRun(run: unknown): string;
  revisionLine(rev: string | null, revTime: number | null, mainTime: number | null): string;
};

const KST = "Asia/Seoul";

describe("idle agents: once a day by local date", () => {
  it("a run at 08:30 local is not repeated at 09:40 local the same day", () => {
    // 08:30 KST on 2026-11-15 is 23:30 UTC on 2026-11-14: the stored UTC date is the day before.
    const last = new Date("2026-11-14T23:30:00+00:00").toISOString();
    expect(last.slice(0, 10)).toBe("2026-11-14");
    const now = new Date("2026-11-15T09:40:00+09:00");
    expect(schedule.localDate(last, KST)).toBe("2026-11-15");
    expect(schedule.isDue(last, now, KST)).toBe(false);
    expect(schedule.pick(["gongbang-user-en"], { "gongbang-user-en": last }, () => true, now, KST)).toBeNull();
  });

  it("the same holds in the host's own zone", () => {
    const last = new Date(2026, 10, 15, 8, 30).toISOString();
    expect(schedule.isDue(last, new Date(2026, 10, 15, 9, 40))).toBe(false);
    expect(schedule.isDue(last, new Date(2026, 10, 16, 8, 0))).toBe(true);
  });

  it("is due again on the next local day, also when the stored UTC date differs from the local date", () => {
    const last = "2026-11-14T23:30:00.000Z"; // 2026-11-15 08:30 KST
    expect(schedule.isDue(last, new Date("2026-11-15T23:59:00+09:00"), KST)).toBe(false);
    expect(schedule.isDue(last, new Date("2026-11-16T00:05:00+09:00"), KST)).toBe(true);
    // A late-evening run: stored UTC date 2026-11-15 equals the local date; due on 2026-11-16 local.
    const evening = "2026-11-15T13:00:00.000Z"; // 22:00 KST
    expect(schedule.isDue(evening, new Date("2026-11-16T08:00:00+09:00"), KST)).toBe(true);
  });

  it("picks the due agent that ran longest ago, never-run first, skipping ones not allowed", () => {
    const now = new Date("2026-11-16T10:00:00+09:00");
    const last = { a: "2026-11-15T01:00:00.000Z", b: "2026-11-14T01:00:00.000Z", c: "2026-11-16T00:30:00.000Z" };
    expect(schedule.pick(["a", "b", "c", "d"], last, () => true, now, KST)).toBe("d");
    expect(schedule.pick(["a", "b", "c", "d"], last, (x) => x !== "d", now, KST)).toBe("b");
    expect(schedule.pick(["a", "b", "c"], last, (x) => x === "c", now, KST)).toBeNull();
  });
});

describe("idle agents: run record", () => {
  it("counts browser tool calls in a stream-json log and skips other lines", () => {
    const log = [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__playwright__browser_navigate" }, { type: "text", text: "hi" }] } }),
      "not json",
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }, { type: "tool_use", name: "mcp__playwright__browser_snapshot" }] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", name: "mcp__playwright__browser_snapshot" }] } }),
    ].join("\n");
    expect(schedule.countBrowserCalls(log)).toBe(2);
    expect(schedule.countBrowserCalls("")).toBe(0);
  });

  it("describes a run's length and browser use, and older runs as unknown", () => {
    expect(schedule.describeRun({ seconds: 312, browserCalls: 4 })).toBe("length 312 s, browser yes (4 calls)");
    expect(schedule.describeRun({ seconds: 40, browserCalls: 0 })).toBe("length 40 s, browser no");
    expect(schedule.describeRun(undefined)).toBe("length unknown, browser unknown");
  });
});

describe("idle agents: project factory revision", () => {
  const main = Date.parse("2026-11-15T12:00:00Z") / 1000;

  it("says how far behind origin/main the project factory is, and flags more than a day", () => {
    expect(schedule.revisionLine("abcdef1234567890", main - 3 * 3600, main)).toContain("3 h behind origin/main (within a day");
    expect(schedule.revisionLine("abcdef1234567890", main - 30 * 3600, main)).toContain("MORE than a day behind");
  });

  it("reports a missing supervisor.json or an unknown rev as unknown", () => {
    expect(schedule.revisionLine(null, null, main)).toContain("unknown");
    expect(schedule.revisionLine("abcdef", null, main)).toContain("unknown");
  });
});
