import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import {
  MigrationPendingError,
  PROJECT_KEYS_STEP,
  liveSupervisor,
  migrateFlags,
  migrateWithSupervisor,
  parseMigrateArgs,
  pendingReport,
} from "../src/impl/store/mysql/migrate-command.js";
import type { MigrationStatus } from "../src/impl/store/mysql/migrations.js";
import {
  MIGRATION_PENDING_CODE,
  SUPERVISOR_REQUEST_FILE,
  SUPERVISOR_STATUS_FILE,
  type SupervisorRequest,
  type SupervisorStatus,
} from "../src/interfaces/updater.js";
import { migrationPendingBanner, readFactoryStatus } from "../src/ui/factory-status.js";
import { waitFor } from "./helpers/fakes.js";

// `npm run migrate` while the factory runs (design: Self-update, MySQL schema steps): the machine-readable
// status the updater checks, the drain/start/cancel request protocol from the migrate side, and the banner.

const schema = (state: number | null, latest: number, pending: string[], refusal: string | null = null): MigrationStatus => ({
  state,
  latest,
  refusal,
  pending: pending.map((label, i) => ({ number: (state ?? 11) + i + 1, label, kind: "sql" as const })),
});

describe("migrate --status --json: the pending report", () => {
  it("schema steps pending: lists them; the project-key step is reported as after the schema steps and not counted", async () => {
    let counted = 0;
    const r = await pendingReport({ schema: async () => schema(17, 19, ["0018-a.sql", "0019-b.sql"]), legacyRows: async () => (counted++, 3) });
    expect(r).toEqual({
      store: "mysql",
      schema: { state: 17, latest: 19, pending: ["0018-a.sql", "0019-b.sql"], refusal: null },
      project_keys: { status: "after_schema_steps", rows: null },
      pending: ["0018-a.sql", "0019-b.sql"],
    });
    expect(counted).toBe(0);
  });

  it("schema current with owner/name rows left: the project-key step is pending", async () => {
    const r = await pendingReport({ schema: async () => schema(19, 19, []), legacyRows: async () => 3 });
    expect(r.pending).toEqual([PROJECT_KEYS_STEP]);
    expect(r.project_keys).toEqual({ status: "pending", rows: 3 });
  });

  it("nothing pending, on MySQL and on SQLite (no schema scripts)", async () => {
    expect((await pendingReport({ schema: async () => schema(19, 19, []), legacyRows: async () => 0 })).pending).toEqual([]);
    const sqlite = await pendingReport({ schema: async () => null, legacyRows: async () => 0 });
    expect(sqlite).toMatchObject({ store: "sqlite", schema: null, project_keys: { status: "done", rows: 0 }, pending: [] });
  });

  it("a refused database is pending (the child would refuse too), and a database ahead of the code is not", async () => {
    expect((await pendingReport({ schema: async () => schema(null, 19, [], "not a factory database"), legacyRows: async () => 0 })).pending).toEqual([
      "refused: not a factory database",
    ]);
    expect((await pendingReport({ schema: async () => schema(20, 19, []), legacyRows: async () => 0 })).pending).toEqual([]);
  });

  it("--json and --no-drain parse as arguments and as npm config; plain --status is unchanged", () => {
    expect(parseMigrateArgs(["--status", "--json"])).toBe("status");
    expect(parseMigrateArgs(["--no-drain"])).toBe("apply");
    expect(parseMigrateArgs(["--status"])).toBe("status");
    expect(migrateFlags(["--status", "--json"])).toEqual({ json: true, noDrain: false });
    expect(migrateFlags(["--no-drain"])).toEqual({ json: false, noDrain: true });
    // `npm run migrate --no-drain` sets npm_config_drain to ""; `--json` sets npm_config_json to "true".
    expect(migrateFlags([], { npm_config_drain: "" })).toEqual({ json: false, noDrain: true });
    expect(migrateFlags([], { npm_config_json: "true" })).toEqual({ json: true, noDrain: false });
    expect(migrateFlags([], {})).toEqual({ json: false, noDrain: false });
  });

  it("a supervised child's start error carries the stable code and the step names", () => {
    const err = new MigrationPendingError("1 schema step pending", ["0018-a.sql"]);
    expect(err.code).toBe(MIGRATION_PENDING_CODE);
    expect(err.pending).toEqual(["0018-a.sql"]);
  });
});

/** A state dir with a supervisor.json the test edits as the supervisor would. */
function stateDir(status: Partial<SupervisorStatus>) {
  const dir = mkdtempSync(join(tmpdir(), "sf-migrate-run-"));
  const write = (s: Partial<SupervisorStatus>) => writeFileSync(join(dir, SUPERVISOR_STATUS_FILE), JSON.stringify(s));
  const base: SupervisorStatus = {
    state: "migration_pending",
    rev: "c1c1c1c1c1c1",
    target_rev: "c2c2c2c2c2c2",
    child_pid: 1,
    draining_pids: [],
    since: "2026-01-01T00:00:00.000Z",
    pending_steps: ["0018-a.sql"],
    target_dir: "/state/versions/c2c2c2c2c2c2",
    supervisor_pid: 4242,
    held: false,
    ...status,
  };
  write(base);
  const request = () =>
    existsSync(join(dir, SUPERVISOR_REQUEST_FILE)) ? (JSON.parse(readFileSync(join(dir, SUPERVISOR_REQUEST_FILE), "utf8")) as SupervisorRequest) : null;
  return { dir, base, write: (s: Partial<SupervisorStatus>) => write({ ...base, ...s }), request };
}

describe("npm run migrate while the factory runs", () => {
  it("finds a live supervisor only through the pid in supervisor.json; none, a dead pid or stopped: apply directly", async () => {
    const alive = (pid: number) => pid === 4242;
    expect(await liveSupervisor(mkdtempSync(join(tmpdir(), "sf-none-")), alive)).toBeNull();
    expect(await liveSupervisor(stateDir({ supervisor_pid: 99 }).dir, alive)).toBeNull();
    expect(await liveSupervisor(stateDir({ supervisor_pid: 4242, state: "stopped" }).dir, alive)).toBeNull();
    expect(await liveSupervisor(stateDir({}).dir, alive)).toMatchObject({ supervisor_pid: 4242, target_rev: "c2c2c2c2c2c2" });
    // An older supervisor writes no pid: apply directly, as before.
    const old = stateDir({});
    const { supervisor_pid: _pid, ...withoutPid } = old.base;
    writeFileSync(join(old.dir, SUPERVISOR_STATUS_FILE), JSON.stringify(withoutPid));
    expect(await liveSupervisor(old.dir, () => true)).toBeNull();
  });

  function run(s: ReturnType<typeof stateDir>, opts: { alive: Set<number>; apply?: () => Promise<number>; timeout?: number }) {
    const clock = new FakeClock();
    const lines: string[] = [];
    const calls: string[] = [];
    const done = migrateWithSupervisor(s.base, {
      stateDir: s.dir,
      clock,
      alive: (pid) => opts.alive.has(pid),
      drainTimeoutMs: opts.timeout ?? 60_000,
      stepMs: 1000,
      progressMs: 10_000,
      pid: 777,
      print: (l) => lines.push(l),
      apply: async (target) => {
        calls.push(`apply ${target?.rev} from ${target?.dir}`);
        return opts.apply ? opts.apply() : 0;
      },
    });
    return { clock, lines, calls, done };
  }

  const tick = async (clock: FakeClock, ms = 1000) => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    clock.advance(ms);
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  };

  it("writes a drain request, waits (printing progress) until the supervisor holds and no child is live, applies the target's steps, then writes start", async () => {
    const s = stateDir({});
    const alive = new Set([1, 4242]);
    const r = run(s, { alive });
    await waitFor(() => s.request()?.action === "drain", "drain request");
    expect(s.request()).toMatchObject({ action: "drain", target_rev: "c2c2c2c2c2c2", pid: 777 });
    await tick(r.clock);
    s.write({ state: "draining", held: true, child_pid: 1, draining_pids: [1] }); // the supervisor took it
    for (let i = 0; i < 12; i++) await tick(r.clock);
    expect(r.calls).toEqual([]); // child 1 still finishing its run
    alive.delete(1);
    s.write({ state: "draining", held: true, child_pid: null, draining_pids: [] });
    await tick(r.clock);
    expect(await r.done).toBe(0);
    expect(r.calls).toEqual(["apply c2c2c2c2c2c2 from /state/versions/c2c2c2c2c2c2"]);
    expect(s.request()).toMatchObject({ action: "start", target_rev: "c2c2c2c2c2c2" });
    expect(r.lines.some((l) => /waiting for the supervisor to take the drain request/.test(l))).toBe(true);
    expect(r.lines.filter((l) => /waiting for 1 child to finish \(pids 1\)/.test(l)).length).toBeGreaterThanOrEqual(2); // repeated while it waits
    expect(r.lines.some((l) => /starts c2c2c2c on its next poll/.test(l))).toBe(true);
  });

  it("a held status whose listed pid is already dead counts as no child live", async () => {
    const s = stateDir({ state: "draining", held: true, child_pid: 1, draining_pids: [1] });
    const r = run(s, { alive: new Set([4242]) });
    await tick(r.clock);
    expect(await r.done).toBe(0);
  });

  it("applying fails: writes cancel, so the supervisor restarts the old revision", async () => {
    const s = stateDir({ state: "draining", held: true, child_pid: null });
    const r = run(s, { alive: new Set([4242]), apply: async () => 1 });
    expect(await r.done).toBe(1);
    expect(s.request()).toMatchObject({ action: "cancel" });
    expect(r.lines.at(-1)).toMatch(/restarts c1c1c1c from its own folder/);
  });

  it("gives up at the drain timeout: writes cancel and applies nothing", async () => {
    const s = stateDir({ state: "draining", held: true, child_pid: 1 });
    const r = run(s, { alive: new Set([1, 4242]), timeout: 5000 });
    for (let i = 0; i < 7; i++) await tick(r.clock);
    expect(await r.done).toBe(1);
    expect(r.calls).toEqual([]);
    expect(s.request()).toMatchObject({ action: "cancel" });
    expect(r.lines.at(-1)).toMatch(/gave up after 5 s/);
  });

  it("with no update waiting it still drains, applies this checkout's steps, and asks for a restart", async () => {
    const s = stateDir({ state: "running", target_rev: null, target_dir: null, pending_steps: [], held: true, child_pid: null });
    const r = run(s, { alive: new Set([4242]) });
    expect(await r.done).toBe(0);
    expect(r.calls).toEqual(["apply undefined from undefined"]);
    expect(s.request()).toMatchObject({ action: "start", target_rev: null });
  });
});

describe("status banner for a waiting update", () => {
  const status = { rev: "c1c1c1c1c1c1", target_rev: "c2c2c2c2c2c2", child_pid: 1, error: null, pending_steps: ["0018-a.sql", "project-keys"] };

  it("reads: Update to <new> waits for `npm run migrate` (pending: <steps>). Still running <old> with its settings.", () => {
    expect(migrationPendingBanner(status)).toBe(
      "Update to c2c2c2c waits for `npm run migrate` (pending: 0018-a.sql, project-keys). Still running c1c1c1c with its settings.",
    );
  });

  it("the page reads it as running with the banner (the old child still claims); with no child, as crashed with the banner as the reason", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-banner-"));
    const file = join(dir, SUPERVISOR_STATUS_FILE);
    writeFileSync(file, JSON.stringify({ ...status, state: "migration_pending", since: "x", draining_pids: [] }));
    expect(await readFactoryStatus(file, 2, () => true)).toMatchObject({
      state: "running",
      migration_pending: true,
      banner: migrationPendingBanner(status),
    });
    writeFileSync(file, JSON.stringify({ ...status, rev: "c2c2c2c2c2c2", child_pid: null, state: "migration_pending", since: "x" }));
    const r = await readFactoryStatus(file, 2, () => true);
    expect(r).toMatchObject({ state: "crashed", migration_pending: true });
    expect(r?.error).toMatch(/^Update to c2c2c2c waits for `npm run migrate` \(pending: 0018-a.sql, project-keys\)\. No revision is running/);
  });
});
