import { describe, expect, it } from "vitest";
import { parseQuickAdd } from "../src/core/quick-add.js";
import { localDate, nextDueDate } from "../src/core/tasks.js";

// The quick-add parser (design 02-tasks, issue #606): one test per accepted form and per refusal.

const ok = (words: string) => {
  const r = parseQuickAdd(words);
  if (!r.ok) throw new Error(r.reason);
  return r.task;
};
const refused = (words: string) => {
  const r = parseQuickAdd(words);
  if (r.ok) throw new Error(`accepted: ${JSON.stringify(r.task)}`);
  return r.reason;
};

describe("parseQuickAdd accepts", () => {
  it("plain words: the title, every field unset", () => {
    expect(ok("  buy   milk ")).toEqual({ title: "buy milk", list: null, priority: null, due: null, due_time: null, recurrence: null });
  });

  it("today", () => {
    expect(ok("call mum today")).toMatchObject({ title: "call mum", due: { days_from_today: 0 } });
  });

  it("tomorrow", () => {
    expect(ok("Tomorrow call mum")).toMatchObject({ title: "call mum", due: { days_from_today: 1 } });
  });

  it("YYYY-MM-DD", () => {
    expect(ok("pay rent 2028-02-29")).toMatchObject({ title: "pay rent", due: { date: "2028-02-29" } });
  });

  it("HH:MM, alone due today", () => {
    expect(ok("standup 9:05")).toMatchObject({ title: "standup", due: { days_from_today: 0 }, due_time: "09:05" });
    expect(ok("standup tomorrow 23:59")).toMatchObject({ due: { days_from_today: 1 }, due_time: "23:59" });
  });

  it("!1 to !3", () => {
    expect(ok("a !1").priority).toBe(1);
    expect(ok("a !2").priority).toBe(2);
    expect(ok("!3 a").priority).toBe(3);
  });

  it("#label", () => {
    expect(ok("fix bike #home")).toMatchObject({ title: "fix bike", list: "home" });
  });

  it("every day", () => {
    expect(ok("water plants every day today")).toMatchObject({ title: "water plants", recurrence: "day", due: { days_from_today: 0 } });
  });

  it("every week", () => {
    expect(ok("review budget Every Week 2026-11-13")).toMatchObject({ title: "review budget", recurrence: "week", due: { date: "2026-11-13" } });
  });

  it("every month", () => {
    expect(ok("pay rent every month 2026-01-31 !1 #home 08:00")).toEqual({
      title: "pay rent", list: "home", priority: 1, due: { date: "2026-01-31" }, due_time: "08:00", recurrence: "month",
    });
  });
});

describe("parseQuickAdd rejects, with a reason", () => {
  it("a date that is no date, such as 2026-13-01", () => {
    expect(refused("pay 2026-13-01")).toContain("not a date: 2026-13-01");
    expect(refused("pay 2026-02-30")).toContain("not a date");
  });

  it("a time that is no time, such as 25:00", () => {
    expect(refused("call 25:00")).toContain("not a time: 25:00");
    expect(refused("call 10:60")).toContain("not a time");
  });

  it("priority !0 or !4", () => {
    expect(refused("a !0")).toContain("!1, !2 or !3");
    expect(refused("a !4")).toContain("!1, !2 or !3");
  });

  it("an unknown every form, such as every fortnight", () => {
    expect(refused("water every fortnight today")).toContain("unknown recurrence: every fortnight");
    expect(refused("water today every")).toContain("unknown recurrence");
  });

  it("a repeated field", () => {
    expect(refused("a today tomorrow")).toContain("repeated field: due date");
    expect(refused("a 2026-01-01 today")).toContain("repeated field: due date");
    expect(refused("a 09:00 10:00")).toContain("repeated field: due time");
    expect(refused("a !1 !2")).toContain("repeated field: priority");
    expect(refused("a #home #work")).toContain("repeated field: list");
    expect(refused("a every day every week today")).toContain("repeated field: recurrence");
  });

  it("a recurrence with no due date", () => {
    expect(refused("water plants every day")).toContain("every day needs a due date");
  });

  it("an empty title", () => {
    expect(refused("")).toContain("the title is empty");
    expect(refused("today !1 #home every week")).toContain("the title is empty");
  });
});

describe("task dates", () => {
  it("localDate is the calendar date of the given time, never the system clock's", () => {
    expect(localDate(new Date(2020, 1, 28, 12))).toBe("2020-02-28");
    expect(localDate(new Date(2020, 1, 28, 12), 1)).toBe("2020-02-29");
    expect(localDate(new Date(2020, 11, 31, 12), 1)).toBe("2021-01-01");
  });

  it("nextDueDate: a day, a week, or a month later on the same day, the month's last day when shorter", () => {
    expect(nextDueDate("2026-12-31", "day")).toBe("2027-01-01");
    expect(nextDueDate("2026-02-25", "week")).toBe("2026-03-04");
    expect(nextDueDate("2026-01-15", "month")).toBe("2026-02-15");
    expect(nextDueDate("2026-01-31", "month")).toBe("2026-02-28");
    expect(nextDueDate("2026-12-31", "month")).toBe("2027-01-31");
  });
});
