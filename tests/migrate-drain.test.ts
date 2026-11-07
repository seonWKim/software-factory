import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { NoneUpdater } from "../src/impl/updater/none.js";
import { SUPERVISOR_REQUEST_FILE, SUPERVISOR_STATUS_FILE } from "../src/interfaces/updater.js";
import { supervisorLive, withDrain } from "../src/migrate-drain.js";
import { waitFor } from "./helpers/fakes.js";

function stateDir(status: Record<string, unknown> | null) {
  const dir = mkdtempSync(join(tmpdir(), "sf-drain-"));
  const write = (s: Record<string, unknown>) =>
    writeFileSync(join(dir, SUPERVISOR_STATUS_FILE), JSON.stringify({ rev: "c1", target_rev: "c2", child_pid: 7, draining_pids: [], since: "x", supervisor_pid: 99, ...s }));
  if (status) write(status);
  const requestFile = join(dir, SUPERVISOR_REQUEST_FILE);
  const request = () => (existsSync(requestFile) ? (JSON.parse(readFileSync(requestFile, "utf8")) as { action: string }).action : null);
  /** The supervisor's next poll: reads and removes the request. */
  const consume = () => {
    const a = request();
    rmSync(requestFile, { force: true });
    return a;
  };
  return { dir, write, request, consume };
}

const deps = (dir: string, clock: FakeClock, lines: string[], alive = true) => ({
  stateDir: dir,
  clock,
  print: (l: string) => lines.push(l),
  timeoutMs: 120_000,
  pidAlive: () => alive,
});

// Real git or child-process work per test: fast alone, slower under a full parallel run. Above the global 5 s
// testTimeout (vitest.config.ts, unchanged) so host load does not fail them.
describe("migrate: drain handshake with factory dev", { timeout: 30_000 }, () => {
  it("no live supervisor (no status file, stopped, or a dead pid): applies at once, no request", async () => {
    for (const [status, alive] of [[null, true], [{ state: "stopped" }, true], [{ state: "running" }, false]] as const) {
      const s = stateDir(status);
      let applied = 0;
      const code = await withDrain(deps(s.dir, new FakeClock(), [], alive), async () => (applied++, 0));
      expect(code).toBe(0);
      expect(applied).toBe(1);
      expect(s.request()).toBeNull();
    }
    expect(await supervisorLive(stateDir({ state: "running" }).dir, () => true)).toBe(true);
  });

  it("an in-place (updater none) status has no supervisor_pid: not a live supervisor, so migrate applies at once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-drain-"));
    const run = async () => ({ exit_code: 0, signal: null, stdout: "c1\n", stderr: "", timed_out: false });
    const updater = new NoneUpdater({ repoPath: dir, run, env: {}, clock: new FakeClock(), log: { info() {}, warn() {}, error() {} }, statusFile: join(dir, SUPERVISOR_STATUS_FILE) });
    await updater.start();
    const status = JSON.parse(readFileSync(join(dir, SUPERVISOR_STATUS_FILE), "utf8")) as Record<string, unknown>;
    expect(status).toMatchObject({ state: "running", child_pid: process.pid });
    expect(status).not.toHaveProperty("supervisor_pid");
    expect(await supervisorLive(dir, () => true)).toBe(false);
  });

  it("asks for a drain, applies only once migration_ready and the request was read, then asks for a start", async () => {
    const s = stateDir({ state: "migration_pending" });
    const clock = new FakeClock();
    const lines: string[] = [];
    let appliedWhen: string | null = null;
    const done = withDrain(deps(s.dir, clock, lines), async () => {
      appliedWhen = JSON.parse(readFileSync(join(s.dir, SUPERVISOR_STATUS_FILE), "utf8")).state;
      return 0;
    });
    await waitFor(() => s.request() === "drain", "drain request");
    s.write({ state: "migration_ready", child_pid: null }); // ready, but the request not read yet: still waits
    clock.advance(1000);
    await new Promise((r) => setImmediate(r));
    expect(appliedWhen).toBeNull();
    expect(s.consume()).toBe("drain");
    clock.advance(1000);
    expect(await done).toBe(0);
    expect(appliedWhen).toBe("migration_ready");
    expect(s.request()).toBe("start");
    expect(lines[0]).toContain("asking it to drain");
  });

  it("a failed apply asks for a cancel and returns its exit code", async () => {
    const s = stateDir({ state: "migration_ready", child_pid: null });
    const clock = new FakeClock();
    const done = withDrain(deps(s.dir, clock, []), async () => 2);
    await waitFor(() => s.request() === "drain", "drain request");
    s.consume();
    clock.advance(1000);
    expect(await done).toBe(2);
    expect(s.request()).toBe("cancel");
  });

  it("prints progress while it waits; gives up at the timeout with a cancel, nothing applied", async () => {
    const s = stateDir({ state: "migration_draining", child_pid: null, draining_pids: [7, 8] });
    const clock = new FakeClock();
    const lines: string[] = [];
    let applied = false;
    const done = withDrain(deps(s.dir, clock, lines), async () => ((applied = true), 0));
    await waitFor(() => s.request() === "drain", "drain request");
    s.consume();
    let code: number | null = null;
    void done.then((c) => (code = c));
    // Advance until withDrain resolves: its file reads between sleeps can take
    // longer than any fixed pause under load, so a real-time deadline bounds it.
    const deadline = Date.now() + 20_000;
    while (code === null && Date.now() < deadline) {
      clock.advance(1000);
      await new Promise((r) => setTimeout(r, 5)); // the file reads between sleeps
    }
    if (code === null) throw new Error("withDrain did not resolve within 20 s of real time");
    expect(code).toBe(1);
    expect(applied).toBe(false);
    expect(s.request()).toBe("cancel");
    expect(lines.some((l) => l.includes("still waiting for the drain: 2 processes"))).toBe(true);
    expect(lines.at(-1)).toContain("did not drain within 120 s");
  });
});
