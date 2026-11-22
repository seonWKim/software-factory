// The cleanup of closed items' leftovers (design 08-cleanup): the close callback, the daily sweep, the in-use guard,
// the history lines, failures, the dry run, the off switch, handler discovery and each handler. Real git in temporary
// repositories and run folders made by NoOpSandbox; a fake store, clock and process table.

import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLEANUP_REASON, Cleaner, type CleanupEnv, type CleanupStore, type HostProcess, type PassResult, type Resource, discoverHandlers, parseLsofCwd, reportLines,
} from "../src/cleanup/index.js";
import type { CleanupLeaseStore, CleanupPort } from "../src/controller/units/cleanup/cleanup.unit.js";
import { CleanupUnit } from "../src/controller/units/cleanup/cleanup.unit.js";
import type { Ctx } from "../src/controller/units/context.js";
import type { Run, Stage, StateChange, WorkItem } from "../src/core/types.js";
import type { CommandRunner } from "../src/interfaces/updater.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { runProcess } from "../src/impl/process/run-process.js";
import { NoOpSandbox } from "../src/impl/sandbox/noop-sandbox.js";
import { git } from "./helpers/git-fixture.js";

const HOUR = 3_600_000;

/** The store calls the cleanup makes, over items, runs and state changes held in memory. */
class FakeStore {
  readonly items = new Map<string, WorkItem>();
  readonly changes = new Map<string, StateChange[]>();
  readonly runs = new Map<string, Run[]>();
  constructor(private readonly clock: FakeClock) {}

  private now = () => this.clock.now().toISOString();

  add(id: string, stage: Stage = "RUNNING"): void {
    this.items.set(id, { id, version: 1, stage, updated_at: this.now() } as unknown as WorkItem);
  }

  private change(id: string, reason: string, changes: StateChange["changes"], detail: StateChange["detail"]): void {
    const item = this.items.get(id)!;
    const next = { ...item, ...(changes.stage ? { stage: changes.stage.to } : {}), version: item.version + 1, updated_at: this.now() } as WorkItem;
    this.items.set(id, next);
    const sc = { id: `sc_${id}_${next.version}`, work_item_id: id, version: next.version, at: this.now(), actor: { kind: "system", id: "system:test" }, reason, changes, detail };
    this.changes.set(id, [...(this.changes.get(id) ?? []), sc as unknown as StateChange]);
  }

  close(id: string): void {
    this.change(id, "closed", { stage: { from: this.items.get(id)!.stage, to: "CLOSED" } }, null);
  }

  run(id: string, r: Partial<Run>): void {
    const list = this.runs.get(id) ?? [];
    list.push({ id: `run_${id}_${list.length}`, work_item_id: id, kind: "implement", status: "succeeded", lease: null, ...r } as Run);
    this.runs.set(id, list);
  }

  history(id: string): StateChange[] {
    return (this.changes.get(id) ?? []).filter((c) => c.reason === CLEANUP_REASON);
  }

  readonly api = {
    getWorkItem: async (id: string) => this.items.get(id) ?? null,
    listRuns: async (id: string) => this.runs.get(id) ?? [],
    listStateChanges: async (id: string) => this.changes.get(id) ?? [],
    listWorkItemsWhere: async (f: { stage?: Stage; updated_since?: string }) =>
      [...this.items.values()].filter((i) => (!f.stage || i.stage === f.stage) && (!f.updated_since || i.updated_at >= f.updated_since)),
    transition: async (input: { id: string; expected_version: number; reason: string; detail?: StateChange["detail"] }) => {
      const item = this.items.get(input.id);
      if (!item) return { ok: false, reason: "not_found" };
      if (item.version !== input.expected_version) return { ok: false, reason: "version_conflict", current: item };
      this.change(input.id, input.reason, {}, input.detail ?? null);
      return { ok: true, item: this.items.get(input.id) };
    },
  } as unknown as CleanupStore;
}

const branches = (dir: string) => git(dir, "for-each-ref", "--format=%(refname:short)", "refs/heads/factory/").split("\n").filter(Boolean);

/** A repository on main with one run folder and one merged `factory/<id>` branch per item, and a detached run folder. */
async function machine(ids: readonly string[] = ["wi_1"]) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sf-cleanup-")));
  writeFileSync(join(dir, ".gitignore"), ".worktrees/\n");
  writeFileSync(join(dir, "a.txt"), "a\n");
  git(dir, "init", "--quiet", "--initial-branch=main");
  git(dir, "add", ".");
  git(dir, "commit", "--quiet", "-m", "init");
  const worktreesDir = join(dir, ".worktrees");
  const sandbox = new NoOpSandbox(worktreesDir, runProcess, undefined, { local: true });
  const folders: Record<string, string> = {};
  for (const id of ids) {
    git(dir, "branch", `factory/${id}`);
    folders[id] = (await sandbox.create({ repo: dir, branch: `factory/${id}`, base_ref: "main" })).workdir;
  }
  const detached = (await sandbox.create({ repo: dir, branch: null, base_ref: "main" })).workdir;
  const procs: HostProcess[] = [];
  const stopped: number[] = [];
  const env: CleanupEnv = {
    repo: dir, worktreesDir, branchPrefix: "factory/", baseBranch: "main", run: runProcess,
    processes: { list: async () => procs, stop: async (pid) => void stopped.push(pid) },
  };
  const clock = new FakeClock("2026-11-20T00:00:00.000Z");
  const store = new FakeStore(clock);
  for (const id of ids) store.add(id);
  const errors: string[] = [];
  const log = { info: () => undefined, warn: () => undefined, error: (m: string, f?: object) => void errors.push(`${m} ${JSON.stringify(f)}`) };
  const cleaner = (o: { enabled?: boolean; keep_hours?: number; run?: CommandRunner } = {}) =>
    new Cleaner({
      store: store.api, env: { ...env, ...(o.run ? { run: o.run } : {}) }, clock, log, host: "h1",
      config: { enabled: o.enabled ?? true, keep_hours: o.keep_hours ?? 24 },
    });
  return { dir, worktreesDir, folders, detached, env, clock, store, procs, stopped, errors, cleaner };
}

type Machine = Awaited<ReturnType<typeof machine>>;

/** wi_1 closed, and the clock past its keep_hours. */
function closedPastKeep(m: Machine, id = "wi_1"): void {
  m.store.close(id);
  m.clock.advance(25 * HOUR);
}

const labels = (xs: readonly { resource: Resource }[]) => xs.map((x) => x.resource.label);
const keptReason = (r: PassResult, label: string) => r.kept.find((k) => k.resource.label === label)?.reason;

describe("close callback", () => {
  it("removes a closed item's run folder and branch once keep_hours passed since the close; before that both stay", async () => {
    const m = await machine();
    const c = m.cleaner();
    m.store.close("wi_1");
    m.clock.advance(23 * HOUR);
    await c.closeStep();
    expect(existsSync(m.folders.wi_1!)).toBe(true);
    expect(branches(m.dir)).toContain("factory/wi_1");
    m.clock.advance(HOUR);
    await c.closeStep();
    expect(existsSync(m.folders.wi_1!)).toBe(false);
    expect(branches(m.dir)).not.toContain("factory/wi_1");
  });

  it("touches only the closed item's resources, and keep_hours 0 removes them at the next poll", async () => {
    const m = await machine(["wi_1", "wi_2"]);
    m.store.close("wi_1");
    await m.cleaner({ keep_hours: 0 }).closeStep();
    expect(existsSync(m.folders.wi_1!)).toBe(false);
    expect(existsSync(m.folders.wi_2!)).toBe(true);
    expect(branches(m.dir)).toEqual(expect.arrayContaining(["factory/wi_2"]));
    expect(existsSync(m.detached)).toBe(true);
  });
});

describe("daily sweep", () => {
  it("removes the leftovers of an item closed before this change, which the close callback no longer looks at", async () => {
    const m = await machine();
    m.store.close("wi_1");
    m.clock.advance(10 * 24 * HOUR);
    const c = m.cleaner();
    await c.closeStep();
    expect(existsSync(m.folders.wi_1!)).toBe(true);
    const r = await c.sweep();
    expect(labels(r.removed)).toEqual(expect.arrayContaining([`run folder ${m.folders.wi_1}`, "branch factory/wi_1"]));
    expect(existsSync(m.folders.wi_1!)).toBe(false);
    expect(branches(m.dir)).not.toContain("factory/wi_1");
  });

  it("keeps a detached run folder (a triage run), naming why", async () => {
    const m = await machine();
    closedPastKeep(m);
    const r = await m.cleaner().sweep();
    expect(keptReason(r, `run folder ${m.detached}`)).toContain("detached");
    expect(existsSync(m.detached)).toBe(true);
  });
});

describe("in-use guard", () => {
  const folderAndBranch = (m: Machine) => [`run folder ${m.folders.wi_1}`, "branch factory/wi_1"];

  async function expectAllKept(m: Machine, reason: string): Promise<void> {
    m.procs.push({ pid: 4242, command: "node", cwd: join(m.folders.wi_1!, "web") });
    const r = await m.cleaner().sweep();
    for (const label of [...folderAndBranch(m), `process 4242 (node) in ${join(m.folders.wi_1!, "web")}`]) expect(keptReason(r, label)).toContain(reason);
    expect(existsSync(m.folders.wi_1!)).toBe(true);
    expect(branches(m.dir)).toContain("factory/wi_1");
    expect(m.stopped).toEqual([]);
    expect(m.store.history("wi_1")).toEqual([]);
  }

  it("keeps everything of an item with a running run", async () => {
    const m = await machine();
    closedPastKeep(m);
    m.store.run("wi_1", { status: "running" });
    await expectAllKept(m, "is running");
  });

  it("keeps everything of an item with a run holding a lease", async () => {
    const m = await machine();
    closedPastKeep(m);
    m.store.run("wi_1", { status: "queued", lease: { owner: "w1", token: 1, expires_at: new Date(m.clock.now().getTime() + 60_000).toISOString() } } as Partial<Run>);
    await expectAllKept(m, "holds a lease");
  });

  it("keeps everything of an item with an open interactive session", async () => {
    const m = await machine();
    closedPastKeep(m);
    m.store.run("wi_1", { kind: "interactive", status: "running" });
    await expectAllKept(m, "interactive session");
  });

  it("keeps everything of an item that is not closed", async () => {
    const m = await machine();
    m.clock.advance(25 * HOUR);
    await expectAllKept(m, "not closed");
  });

  it("keeps a branch the branch decision does not allow: one not merged into the base", async () => {
    const m = await machine();
    const sha = git(m.dir, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "unmerged");
    git(m.dir, "update-ref", "refs/heads/factory/wi_1", sha);
    closedPastKeep(m);
    const r = await m.cleaner().sweep();
    expect(keptReason(r, "branch factory/wi_1")).toBe("not merged into main");
    expect(branches(m.dir)).toContain("factory/wi_1");
    expect(existsSync(m.folders.wi_1!)).toBe(false);
  });

  it("never stops a process outside a removable run folder: the repository, another item's open folder, a dirty folder", async () => {
    const m = await machine(["wi_1", "wi_2", "wi_3"]);
    m.store.close("wi_3");
    closedPastKeep(m);
    writeFileSync(join(m.folders.wi_3!, "a.txt"), "changed\n");
    m.procs.push(
      { pid: 1, command: "node", cwd: m.dir },
      { pid: 2, command: "vite", cwd: m.folders.wi_2! },
      { pid: 3, command: "chrome", cwd: m.folders.wi_3! },
      { pid: 4, command: "node", cwd: join(m.folders.wi_1!, "web") },
    );
    const r = await m.cleaner().sweep();
    expect(m.stopped).toEqual([4]);
    expect(keptReason(r, `process 2 (vite) in ${m.folders.wi_2}`)).toContain("not closed");
    expect(keptReason(r, `process 3 (chrome) in ${m.folders.wi_3}`)).toContain("uncommitted changes");
    expect(labels(r.kept)).not.toContain(`process 1 (node) in ${m.dir}`);
  });
});

describe("history", () => {
  it("writes one line per removal naming what went and the bytes freed; a branch and a process show no size", async () => {
    const m = await machine();
    m.procs.push({ pid: 7, command: "node", cwd: m.folders.wi_1! });
    closedPastKeep(m);
    await m.cleaner().sweep();
    const lines = m.store.history("wi_1").map((c) => c.detail!);
    const one = (label: string) => lines.filter((d) => d.removed === label);
    expect(one(`run folder ${m.folders.wi_1}`)).toEqual([expect.objectContaining({ bytes_freed: expect.any(Number) })]);
    expect(one(`run folder ${m.folders.wi_1}`)[0]!.bytes_freed).toBeGreaterThan(0);
    expect(one("branch factory/wi_1")).toHaveLength(1);
    expect(one("branch factory/wi_1")[0]).not.toHaveProperty("bytes_freed");
    expect(one(`process 7 (node) in ${m.folders.wi_1}`)[0]).not.toHaveProperty("bytes_freed");
    expect(m.store.items.get("wi_1")!.stage).toBe("CLOSED");
  });
});

describe("a failed removal", () => {
  it("is logged, does not stop the close step or the other removals, and the next sweep removes it", async () => {
    const m = await machine();
    m.store.close("wi_1");
    m.clock.advance(25 * HOUR);
    const failing: CommandRunner = (cmd, opts) => (cmd[1] === "update-ref" ? Promise.resolve({ exit_code: 1, signal: null, stdout: "", stderr: "forced", timed_out: false }) : runProcess(cmd, opts));
    const r = await m.cleaner({ run: failing }).closeStep();
    expect(labels(r!.failed)).toEqual(["branch factory/wi_1"]);
    expect(m.errors.some((e) => e.startsWith("cleanup removal failed") && e.includes("factory/wi_1"))).toBe(true);
    expect(existsSync(m.folders.wi_1!)).toBe(false);
    expect(branches(m.dir)).toContain("factory/wi_1");
    expect(m.store.items.get("wi_1")!.stage).toBe("CLOSED");
    expect(m.store.history("wi_1").map((c) => c.detail!.removed)).not.toContain("branch factory/wi_1");
    await m.cleaner().sweep();
    expect(branches(m.dir)).not.toContain("factory/wi_1");
    expect(m.store.history("wi_1").map((c) => c.detail!.removed)).toContain("branch factory/wi_1");
  });
});

describe("dry run", () => {
  it("lists each resource that would go and each kept one with its reason, and changes no file, branch or history", async () => {
    const m = await machine(["wi_1", "wi_2"]);
    closedPastKeep(m);
    const r = await m.cleaner().sweep({ dryRun: true });
    expect(labels(r.removed)).toEqual(expect.arrayContaining([`run folder ${m.folders.wi_1}`, "branch factory/wi_1"]));
    expect(keptReason(r, `run folder ${m.folders.wi_2}`)).toContain("not closed");
    const lines = reportLines(r, true);
    expect(lines).toEqual(expect.arrayContaining(["Would remove:", `  run folder ${m.folders.wi_1}`, "  branch factory/wi_1", "Kept:", "Dry run: nothing was removed."]));
    expect(lines.some((l) => l.startsWith(`  run folder ${m.detached}: detached`))).toBe(true);
    expect(existsSync(m.folders.wi_1!)).toBe(true);
    expect(branches(m.dir)).toEqual(expect.arrayContaining(["factory/wi_1", "factory/wi_2"]));
    expect(m.store.history("wi_1")).toEqual([]);
  });

  it("a real sweep's report prints what it removed, with the size freed, and what it kept", async () => {
    const m = await machine();
    closedPastKeep(m);
    const lines = reportLines(await m.cleaner().sweep(), false);
    expect(lines).toEqual(expect.arrayContaining(["Removed:", "  branch factory/wi_1", "Kept:"]));
    expect(lines.some((l) => l.startsWith(`  run folder ${m.folders.wi_1} (`))).toBe(true);
    expect(lines.some((l) => /^Freed \(/.test(l))).toBe(true);
  });
});

describe("cleanup.enabled", () => {
  it("false turns off the close callback and the sweep: nothing is removed", async () => {
    const m = await machine();
    m.procs.push({ pid: 9, command: "node", cwd: m.folders.wi_1! });
    closedPastKeep(m);
    const c = m.cleaner({ enabled: false });
    expect(await c.closeStep()).toBeNull();
    expect(await c.sweep()).toEqual({ removed: [], kept: [], failed: [] });
    expect(existsSync(m.folders.wi_1!)).toBe(true);
    expect(branches(m.dir)).toContain("factory/wi_1");
    expect(m.stopped).toEqual([]);
  });
});

describe("handler discovery", () => {
  it("finds the run-folder, branch and process handlers, one folder each, a process stopping before its folder goes", async () => {
    const names = (await discoverHandlers()).map((h) => h.name);
    expect(names).toEqual(expect.arrayContaining(["process", "run-folder", "branch"]));
    expect(names.indexOf("process")).toBeLessThan(names.indexOf("run-folder"));
  });

  it("refuses a handler file whose default export is not defineCleanupHandler", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "sf-cleanup-handlers-")));
    mkdirSync(join(dir, "bad"));
    writeFileSync(join(dir, "bad", "bad.cleanup.js"), "export default { name: 'bad' };\n");
    await expect(discoverHandlers(dir)).rejects.toThrow("default export must be defineCleanupHandler");
  });
});

/** Each handler's accepts, cleanup and own in-use check, through the discovered descriptor. */
async function handler(name: string) {
  return (await discoverHandlers()).find((h) => h.name === name)!;
}

describe("run-folder handler", () => {
  it("lists each run folder with the item of its branch, and accepts only run folders", async () => {
    const m = await machine();
    const h = await handler("run-folder");
    const listed = await h.list(m.env);
    const mine = listed.find((r) => r.key === m.folders.wi_1)!;
    expect(mine.item_id).toBe("wi_1");
    expect(h.accepts(mine)).toBe(true);
    expect(h.accepts({ kind: "branch", key: "refs/heads/factory/wi_1", label: "", item_id: "wi_1", data: { ref: "x", sha: "y" } })).toBe(false);
  });

  it("cleanup removes the folder and reports the bytes freed", async () => {
    const m = await machine();
    const h = await handler("run-folder");
    const mine = (await h.list(m.env)).find((r) => r.key === m.folders.wi_1)!;
    expect((await h.cleanup(mine, m.env)).bytes).toBeGreaterThan(0);
    expect(existsSync(m.folders.wi_1!)).toBe(false);
  });

  it("in use: a folder with uncommitted changes, or with commits the repository lacks, stays", async () => {
    const m = await machine(["wi_1", "wi_2"]);
    const h = await handler("run-folder");
    writeFileSync(join(m.folders.wi_1!, "new.txt"), "x\n");
    git(m.folders.wi_2!, "commit", "--quiet", "--allow-empty", "-m", "local only");
    const listed = await h.list(m.env);
    expect(await h.keep(listed.find((r) => r.key === m.folders.wi_1)!, m.env)).toBe("it has uncommitted changes");
    expect(await h.keep(listed.find((r) => r.key === m.folders.wi_2)!, m.env)).toBe("it holds commits the repository does not have");
  });
});

describe("branch handler", () => {
  it("lists each factory branch with its item, and accepts only branches", async () => {
    const m = await machine();
    const h = await handler("branch");
    const mine = (await h.list(m.env)).find((r) => r.key === "refs/heads/factory/wi_1")!;
    expect(mine.item_id).toBe("wi_1");
    expect(h.accepts(mine)).toBe(true);
    expect(h.accepts({ kind: "run-folder", key: "/x", label: "", item_id: "wi_1", data: { path: "/x" } })).toBe(false);
  });

  it("cleanup deletes the local branch at the sha it was listed at, and nothing else", async () => {
    const m = await machine(["wi_1", "wi_2"]);
    const h = await handler("branch");
    const mine = (await h.list(m.env)).find((r) => r.key === "refs/heads/factory/wi_1")!;
    expect(await h.cleanup(mine, m.env)).toEqual({ bytes: null });
    expect(branches(m.dir)).not.toContain("factory/wi_1");
    expect(branches(m.dir)).toContain("factory/wi_2");
  });

  it("in use: a branch checked out in a worktree, or not merged into the base, stays", async () => {
    const m = await machine(["wi_1"]);
    const h = await handler("branch");
    git(m.dir, "branch", "factory/wi_2");
    git(m.dir, "worktree", "add", "--quiet", join(m.dir, "..", `${m.dir.split("/").pop()}-wt`), "factory/wi_2");
    git(m.dir, "update-ref", "refs/heads/factory/wi_1", git(m.dir, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "x"));
    const listed = await h.list(m.env);
    expect(await h.keep(listed.find((r) => r.key === "refs/heads/factory/wi_2")!, m.env)).toBe("checked out in a worktree");
    expect(await h.keep(listed.find((r) => r.key === "refs/heads/factory/wi_1")!, m.env)).toBe("not merged into main");
  });
});

describe("process handler", () => {
  it("lists the processes running inside a run folder, each under that folder, and accepts only processes", async () => {
    const m = await machine();
    const h = await handler("process");
    m.procs.push({ pid: 5, command: "node", cwd: join(m.folders.wi_1!, "web") }, { pid: 6, command: "node", cwd: m.dir }, { pid: process.pid, command: "node", cwd: m.folders.wi_1! });
    const listed = await h.list(m.env);
    expect(listed.map((r) => r.data.pid)).toEqual([5]);
    expect(listed[0]!.parent).toBe(m.folders.wi_1);
    expect(h.accepts(listed[0]!)).toBe(true);
    expect(h.accepts({ kind: "branch", key: "refs/heads/factory/wi_1", label: "", item_id: "wi_1", data: { ref: "x", sha: "y" } })).toBe(false);
  });

  it("cleanup stops the process", async () => {
    const m = await machine();
    const h = await handler("process");
    m.procs.push({ pid: 5, command: "node", cwd: m.folders.wi_1! });
    expect(await h.cleanup((await h.list(m.env))[0]!, m.env)).toEqual({ bytes: null });
    expect(m.stopped).toEqual([5]);
  });

  it("in use: a process whose run folder stays is not stopped", async () => {
    const m = await machine();
    m.procs.push({ pid: 5, command: "node", cwd: m.folders.wi_1! });
    closedPastKeep(m);
    m.store.run("wi_1", { status: "running" });
    const r = await m.cleaner().sweep();
    expect(keptReason(r, `process 5 (node) in ${m.folders.wi_1}`)).toContain(`run folder ${m.folders.wi_1} stays`);
    expect(m.stopped).toEqual([]);
  });

  it("reads lsof's cwd listing", () => {
    expect(parseLsofCwd("p12\ncnode\nfcwd\nn/a/b\np13\ncChrome Helper\nfcwd\nn/c d\n")).toEqual([
      { pid: 12, command: "node", cwd: "/a/b" }, { pid: 13, command: "Chrome Helper", cwd: "/c d" },
    ]);
  });
});

describe("cleanup unit", () => {
  function fakes(enabled = true) {
    const clock = new FakeClock("2026-11-20T10:00:00.000Z");
    const calls: string[] = [];
    const cursors = new Map<string, string>();
    let held = false;
    const store = {
      acquireSyncLease: async (name: string) => (held ? { ok: false, reason: "held", holder: null } : (calls.push(`lease ${name}`), { ok: true, lease: { token: 1 } })),
      releaseSyncLease: async () => void calls.push("release"),
      getCursor: async (name: string) => cursors.get(name) ?? null,
      advanceCursor: async (name: string, _e: string | null, next: string) => (cursors.set(name, next), true),
    } as unknown as CleanupLeaseStore;
    const port: CleanupPort = {
      host: "h1", enabled: () => enabled,
      closeStep: async () => void calls.push("close"), sweep: async () => void calls.push("sweep"),
    };
    const ctx = { k: { nowMs: () => clock.now().getTime(), d: { replica_id: null }, cfg: { lease_ms: 60_000 } } } as unknown as Ctx;
    return { unit: new CleanupUnit(ctx), store, port, calls, cursors, clock, hold: () => void (held = true) };
  }

  it("runs the close callback each step and the sweep once per UTC day, under this host's lease and day mark", async () => {
    const f = fakes();
    await f.unit.cleanupStep(f.store, f.port);
    await f.unit.cleanupStep(f.store, f.port);
    expect(f.calls.filter((c) => c === "sweep")).toEqual(["sweep"]);
    expect(f.calls.filter((c) => c === "close")).toEqual(["close", "close"]);
    expect(f.calls).toContain("lease cleanup:h1");
    expect(f.cursors.get("cleanup:h1")).toBe("2026-11-20");
    f.clock.advance(24 * HOUR);
    await f.unit.cleanupStep(f.store, f.port);
    expect(f.calls.filter((c) => c === "sweep")).toEqual(["sweep", "sweep"]);
  });

  it("does not sweep while another replica holds the lease, and does nothing at all when off", async () => {
    const held = fakes();
    held.hold();
    await held.unit.cleanupStep(held.store, held.port);
    expect(held.calls).toEqual(["close"]);
    const off = fakes(false);
    await off.unit.cleanupStep(off.store, off.port);
    expect(off.calls).toEqual([]);
  });
});
