// The supervisor status the dashboard reads (design 08-self-update, 09-dashboard-shell): previous_rev, the update's
// commit count and subjects, and how the overview's factory object carries them. Fakes only: no git runs.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import type { UpdateChanges } from "../src/impl/updater/code-origin.js";
import { type FactoryStatus, readFactoryStatus } from "../src/ui/factory-status.js";
import { HealthMonitor } from "../src/ui/health.js";
import { type UiDeps, respond } from "../src/ui/server.js";
import { newStore } from "./helpers/store.js";

const AT = "2026-11-19T21:35:00.000Z";
const SECRET = `ghp_${"Ab3".repeat(12)}`;

function statusFile(status: object): string {
  const file = join(mkdtempSync(join(tmpdir(), "sf-fstatus-")), "supervisor.json");
  writeFileSync(file, JSON.stringify(status));
  return file;
}

/** A fake range reader, recording each pair it is asked for. */
function fakeChanges(answer: UpdateChanges) {
  const asked: string[] = [];
  return { asked, read: async (from: string, to: string) => (asked.push(`${from}..${to}`), answer) };
}

describe("readFactoryStatus: the update's changes", () => {
  const base = { state: "running", rev: "3dc0029", target_rev: null, child_pid: 7, since: AT };

  it("reads previous_rev and the changes of previous_rev..rev", async () => {
    const f = fakeChanges({ count: 12, subjects: ["Tell the open tab"] });
    const status = await readFactoryStatus(statusFile({ ...base, previous_rev: "c0147" }), 2, () => true, f.read);
    expect(status).toMatchObject({ rev: "3dc0029", previous_rev: "c0147", changes: { count: 12, subjects: ["Tell the open tab"] } });
    expect(f.asked).toEqual(["c0147..3dc0029"]);
  });

  it("no previous_rev (null or a file from before it) asks git nothing and has no changes", async () => {
    const f = fakeChanges({ count: 1, subjects: [] });
    expect(await readFactoryStatus(statusFile({ ...base, previous_rev: null }), 2, () => true, f.read)).toMatchObject({ changes: null });
    expect(await readFactoryStatus(statusFile(base), 2, () => true, f.read)).toMatchObject({ changes: null });
    expect(f.asked).toEqual([]);
  });
});

describe("overview: the factory object carries previous_rev and the update's changes", () => {
  async function overviewFactory(status: FactoryStatus) {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const d: UiDeps = {
      store,
      scanner: new PatternEgressScanner(async () => []),
      clock,
      lease_ms: 60_000,
      health: new HealthMonitor(async () => [], clock),
      factoryStatus: async () => status,
    };
    const r = await respond(d, { method: "GET", url: "/api/v1/overview", host: "127.0.0.1:4310" });
    return (JSON.parse(r.body) as { factory: Record<string, unknown> }).factory;
  }
  const status = { state: "running", rev: "3dc0029", target_rev: null, child_pid: 7, since: AT, workers: 2 } as const;

  it("passes the count and subjects; a subject with a secret leaves only withheld", async () => {
    const factory = await overviewFactory({ ...status, previous_rev: "c0147", changes: { count: 2, subjects: ["Fix the header", `Leak ${SECRET}`] } });
    expect(factory).toMatchObject({ rev: "3dc0029", previous_rev: "c0147", changes: { count: 2, subjects: ["Fix the header", "[withheld: github_token]"] } });
  });

  it("a git failure (count null) and a status with no previous_rev both pass through as nulls", async () => {
    expect(await overviewFactory({ ...status, previous_rev: "c0147", changes: { count: null, subjects: [] } })).toMatchObject({ changes: { count: null, subjects: [] } });
    expect(await overviewFactory(status)).toMatchObject({ previous_rev: null, changes: null });
  });
});
