// Schedule cadences (design 08-schedules): each kind's next due time is computed on the schedule's own wall clock,
// across daylight-saving changes, and the hand-written 5-field cron parser follows cron's rules.

import { describe, expect, it } from "vitest";
import { type Cadence, cadenceProblem, nextDue } from "../src/core/schedule-cadence.js";

const ANCHOR = new Date("2026-01-01T00:00:00.000Z");
const next = (c: Cadence, zone: string, after: string, anchor = ANCHOR) => nextDue(c, zone, new Date(after), anchor)?.toISOString() ?? null;

describe("daily", () => {
  it("is 09:00 in the schedule's zone, the next day once today's has passed", () => {
    expect(next({ kind: "daily", spec: "09:00" }, "Asia/Seoul", "2026-11-21T23:59:00.000Z")).toBe("2026-11-22T00:00:00.000Z");
    expect(next({ kind: "daily", spec: "09:00" }, "Asia/Seoul", "2026-11-22T00:00:00.000Z")).toBe("2026-11-23T00:00:00.000Z");
  });

  it("stays at 09:00 local across a daylight-saving change", () => {
    expect(next({ kind: "daily", spec: "09:00" }, "America/New_York", "2026-03-07T14:00:00.000Z")).toBe("2026-03-08T13:00:00.000Z");
  });

  it("a time the clocks skip runs after the gap; a time shown twice runs once", () => {
    expect(next({ kind: "daily", spec: "02:30" }, "America/New_York", "2026-03-08T00:00:00.000Z")).toBe("2026-03-08T07:30:00.000Z");
    expect(next({ kind: "daily", spec: "01:30" }, "America/New_York", "2026-11-01T00:00:00.000Z")).toBe("2026-11-01T05:30:00.000Z");
    expect(next({ kind: "daily", spec: "01:30" }, "America/New_York", "2026-11-01T05:30:00.000Z")).toBe("2026-11-02T06:30:00.000Z");
  });
});

describe("weekly", () => {
  it("is the next listed weekday at its time in the zone", () => {
    // Friday 2026-11-20 10:00 in Berlin is past Friday's 09:00, so Monday 2026-11-23 09:00 (08:00Z).
    expect(next({ kind: "weekly", spec: "mon,fri 09:00" }, "Europe/Berlin", "2026-11-20T09:00:00.000Z")).toBe("2026-11-23T08:00:00.000Z");
  });

  it("takes the weekday in the zone, not in UTC", () => {
    // Sunday 2026-11-22 20:00Z is already Monday 05:00 in Seoul, so Monday's 09:00 there.
    expect(next({ kind: "weekly", spec: "mon 09:00" }, "Asia/Seoul", "2026-11-22T20:00:00.000Z")).toBe("2026-11-23T00:00:00.000Z");
  });
});

describe("interval", () => {
  it("counts its slots from the anchor, whenever it is asked", () => {
    expect(next({ kind: "interval", spec: "90" }, "UTC", "2026-01-01T03:20:00.000Z")).toBe("2026-01-01T04:30:00.000Z");
    expect(next({ kind: "interval", spec: "90" }, "UTC", "2026-01-01T04:30:00.000Z")).toBe("2026-01-01T06:00:00.000Z");
  });
});

describe("cron", () => {
  it("steps and ranges in the zone", () => {
    // 17:50 Tokyo on a Friday: the next of */15 in 9-17 on weekdays is Monday 09:00 Tokyo.
    expect(next({ kind: "cron", spec: "*/15 9-17 * * 1-5" }, "Asia/Tokyo", "2026-11-20T08:50:00.000Z")).toBe("2026-11-23T00:00:00.000Z");
    expect(next({ kind: "cron", spec: "*/15 9-17 * * 1-5" }, "Asia/Tokyo", "2026-11-20T01:01:00.000Z")).toBe("2026-11-20T01:15:00.000Z");
  });

  it("with both day fields restricted, matches either, as cron does", () => {
    // Day 13 or a Friday: Friday 2026-11-20 comes before 2026-12-13.
    expect(next({ kind: "cron", spec: "0 12 13 * 5" }, "UTC", "2026-11-14T00:00:00.000Z")).toBe("2026-11-20T12:00:00.000Z");
    expect(next({ kind: "cron", spec: "0 12 13 * *" }, "UTC", "2026-11-14T00:00:00.000Z")).toBe("2026-12-13T12:00:00.000Z");
  });

  it("finds a rare date years ahead, and takes 7 and names for Sunday and months", () => {
    expect(next({ kind: "cron", spec: "0 0 29 2 *" }, "UTC", "2026-11-22T00:00:00.000Z")).toBe("2028-02-29T00:00:00.000Z");
    expect(next({ kind: "cron", spec: "30 8 * dec 7" }, "UTC", "2026-11-22T00:00:00.000Z")).toBe("2026-12-06T08:30:00.000Z");
  });

  it("a date that never comes is no due time", () => {
    expect(next({ kind: "cron", spec: "0 0 31 2 *" }, "UTC", "2026-11-22T00:00:00.000Z")).toBeNull();
  });
});

describe("cadenceProblem", () => {
  it("refuses an unknown zone and malformed specs, and accepts valid ones", () => {
    expect(cadenceProblem({ kind: "daily", spec: "09:00" }, "Mars/Olympus")).toMatch(/time zone/);
    expect(cadenceProblem({ kind: "daily", spec: "9:00" }, "UTC")).toMatch(/HH:MM/);
    expect(cadenceProblem({ kind: "weekly", spec: "someday 09:00" }, "UTC")).toMatch(/weekly/);
    expect(cadenceProblem({ kind: "interval", spec: "0" }, "UTC")).toMatch(/minutes/);
    expect(cadenceProblem({ kind: "cron", spec: "0 9 * *" }, "UTC")).toMatch(/5 fields/);
    expect(cadenceProblem({ kind: "cron", spec: "60 9 * * *" }, "UTC")).toMatch(/outside/);
    expect(cadenceProblem({ kind: "cron", spec: "0 9 * * mon-fri" }, "UTC")).toBeNull();
  });
});
