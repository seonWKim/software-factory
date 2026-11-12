// The local merge check (design §5 Merge check, issue #248): the controller checks each ready-to-merge factory PR
// against the newest base in the factory repo's object store, stores one latest result per item, and starts the
// update run at once on a conflict, keyed as GitHub's change_unmergeable path is. Real git repos for the git side;
// a counting sandbox for the call counts.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { build, loadConfig } from "../src/compose.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import type { SourceType, WorkItem, WorkItemId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { NoOpSandbox } from "../src/impl/sandbox/noop-sandbox.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import type { Sandbox } from "../src/interfaces/sandbox.js";
import { autoResolveKey } from "../src/core/policy.js";
import { FakeAuth, FakeForge, FakeSandbox, FakeSource, alice, cleanScanner, config, fakeRepoLookup, silent } from "./helpers/fakes.js";
import { issue, newStore, system } from "./helpers/store.js";

const PR = 7;

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
}

function commit(dir: string, file: string, text: string, msg: string) {
  writeFileSync(join(dir, file), text);
  git(dir, "add", file);
  git(dir, "commit", "--quiet", "-m", msg);
}

/**
 * An origin, the factory checkout (`repo`, the person's working checkout) and a second clone (`other`) that
 * pushes the newer base and the factory branch.
 */
function repos() {
  const root = mkdtempSync(join(tmpdir(), "sf-merge-check-"));
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  const other = join(root, "other");
  git(root, "init", "--quiet", "--bare", "-b", "main", origin);
  for (const dir of [repo, other]) {
    git(root, "clone", "--quiet", origin, dir);
    git(dir, "config", "user.email", "t@example.com");
    git(dir, "config", "user.name", "t");
  }
  commit(other, "a.txt", "one\ntwo\nthree\n", "init");
  commit(other, "b.txt", "bee\n", "b");
  git(other, "push", "--quiet", "origin", "main");
  git(repo, "pull", "--quiet", "origin", "main");
  return { root, repo, other };
}

/** Pushes `factory/<id>` from `other`, branching off main, with `file` set to `text`. */
function pushBranch(other: string, id: string, file: string, text: string) {
  git(other, "checkout", "--quiet", "-b", `factory/${id}`, "main");
  commit(other, file, text, `branch ${id}`);
  git(other, "push", "--quiet", "origin", `factory/${id}`);
  git(other, "checkout", "--quiet", "main");
}

/** Pushes a newer main from `other` with `file` set to `text`. */
function pushBase(other: string, file: string, text: string) {
  commit(other, file, text, "newer base");
  git(other, "push", "--quiet", "origin", "main");
}

/** `type`: the item's source type, so a controller with only that source applies its transitions. */
async function readyItem(store: FactoryStore, n: number, type: SourceType = "github_issue", change_ref: string | null = String(PR)): Promise<WorkItem> {
  const { item } = await store.createWorkItem({ ...issue(n), source: { ...issue(n).source, type } }, system);
  const r = await store.transition({
    id: item.id, expected_version: item.version, actor: system, reason: "seed",
    patch: { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", change_ref },
  });
  if (!r.ok) throw new Error(r.reason);
  return r.item;
}

async function setup(opts: { sandbox: Sandbox; repo?: string; source?: FakeSource; local_only?: true; forge?: FakeForge }) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const source = opts.source ?? new FakeSource();
  const cfg = { ...config, repo: { ...config.repo, path: opts.repo ?? "/repo" }, ...(opts.local_only ? { local_only: true as const } : {}) };
  const controller = new ControllerRole({
    store, source, auth: new FakeAuth(), clock, config: cfg, log: silent, scanner: cleanScanner, sandbox: opts.sandbox, ...(opts.forge ? { forge: opts.forge } : {}),
  });
  return { clock, store, source, controller };
}

const updates = async (store: FactoryStore, id: WorkItemId) => (await store.listRuns(id)).filter((r) => r.kind === "update");

/** The checkout's HEAD, index and working tree, as text. */
function checkoutState(repo: string): string {
  return [
    git(repo, "rev-parse", "HEAD"),
    git(repo, "symbolic-ref", "HEAD"),
    git(repo, "ls-files", "--stage"),
    git(repo, "status", "--porcelain=v1", "--untracked-files=all"),
    git(repo, "diff"),
    git(repo, "diff", "--cached"),
    readFileSync(join(repo, "a.txt"), "utf8"),
    readFileSync(join(repo, "b.txt"), "utf8"),
  ].join("\n--\n");
}

describe("merge check: real git", () => {
  it("a branch that conflicts with a newer base is stored as conflicts with the file names, and the update run starts at once", async () => {
    const { root, repo, other } = repos();
    const sandbox = new NoOpSandbox(join(root, "wt"));
    const { store, controller } = await setup({ sandbox, repo });
    const it1 = await readyItem(store, 1);
    pushBranch(other, it1.id, "a.txt", "one\nTWO-branch\nthree\n");
    pushBase(other, "a.txt", "one\nTWO-base\nthree\n");

    await controller.tickMergeCheck();

    const check = await store.getMergeCheck(it1.id);
    const head = git(other, "rev-parse", `factory/${it1.id}`).trim();
    const base = git(other, "rev-parse", "main").trim();
    expect(check).toMatchObject({ work_item_id: it1.id, mergeable: false, conflicts: ["a.txt"], head_sha: head, base_sha: base });
    expect(typeof check!.checked_at).toBe("string");
    const runs = await updates(store, it1.id);
    expect(runs.map((r) => r.idempotency_key)).toEqual([`${it1.id}:update:${PR}:${head}:${base}`]);
  });

  it("a branch that merges cleanly is stored as mergeable and starts nothing", async () => {
    const { root, repo, other } = repos();
    const { store, controller } = await setup({ sandbox: new NoOpSandbox(join(root, "wt")), repo });
    const it1 = await readyItem(store, 1);
    pushBranch(other, it1.id, "a.txt", "one\nTWO-branch\nthree\n");
    pushBase(other, "b.txt", "bee and more\n");

    await controller.tickMergeCheck();

    expect(await store.getMergeCheck(it1.id)).toMatchObject({ mergeable: true, conflicts: [], base_sha: git(other, "rev-parse", "main").trim() });
    expect(await updates(store, it1.id)).toEqual([]);
  });

  it("leaves the person's working checkout as it was: HEAD, index and working tree", async () => {
    const { root, repo, other } = repos();
    const { store, controller } = await setup({ sandbox: new NoOpSandbox(join(root, "wt")), repo });
    const it1 = await readyItem(store, 1);
    pushBranch(other, it1.id, "a.txt", "one\nTWO-branch\nthree\n");
    pushBase(other, "a.txt", "one\nTWO-base\nthree\n");
    // The person's own state: a staged change, an unstaged change and an untracked file.
    writeFileSync(join(repo, "b.txt"), "staged\n");
    git(repo, "add", "b.txt");
    writeFileSync(join(repo, "a.txt"), "unstaged edit\n");
    writeFileSync(join(repo, "new.txt"), "untracked\n");
    const before = checkoutState(repo);

    await controller.tickMergeCheck();

    expect((await store.getMergeCheck(it1.id))?.mergeable).toBe(false);
    expect(checkoutState(repo)).toBe(before);
    expect(git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
  });

  it("an item whose branch is not on origin is skipped", async () => {
    const { root, repo } = repos();
    const { store, controller } = await setup({ sandbox: new NoOpSandbox(join(root, "wt")), repo });
    const it1 = await readyItem(store, 1);
    await controller.tickMergeCheck();
    expect(await store.getMergeCheck(it1.id)).toBeNull();
  });
});

/** A sandbox whose fetches and merge check are scripted and counted. */
class CountingSandbox extends FakeSandbox {
  base = "b".repeat(40);
  heads: Record<string, string | null> = {};
  result: { mergeable: boolean; conflicts: string[] } = { mergeable: false, conflicts: ["src/x.ts", "src/y.ts"] };
  calls = { updateBase: 0, fetchBranch: 0, mergeCheck: 0 };
  override async updateBase(): Promise<string> {
    this.calls.updateBase++;
    return this.base;
  }
  async fetchBranch(spec: { repo: string; branch: string }): Promise<string | null> {
    this.calls.fetchBranch++;
    return this.heads[spec.branch] ?? null;
  }
  async mergeCheck(): Promise<{ mergeable: boolean; conflicts: string[] }> {
    this.calls.mergeCheck++;
    return this.result;
  }
}

async function counted(opts: { source?: FakeSource } = {}) {
  const sandbox = new CountingSandbox();
  const s = await setup({ sandbox, ...opts });
  const item = await readyItem(s.store, 1, s.source.type);
  sandbox.heads[`factory/${item.id}`] = "a".repeat(40);
  return { ...s, sandbox, item };
}

describe("merge check: caching, throttling and the update run", () => {
  it("two refreshes with the same head and base run the git merge check once", async () => {
    const { clock, controller, sandbox } = await counted();
    await controller.tickMergeCheck();
    clock.advance(config.poll_interval_ms);
    await controller.tickMergeCheck();
    expect(sandbox.calls.updateBase).toBe(2);
    expect(sandbox.calls.mergeCheck).toBe(1);
  });

  it("a new base sha is checked again and stored as the one latest result", async () => {
    const { clock, controller, sandbox, store, item } = await counted();
    await controller.tickMergeCheck();
    clock.advance(config.poll_interval_ms);
    sandbox.base = "c".repeat(40);
    sandbox.result = { mergeable: true, conflicts: [] };
    await controller.tickMergeCheck();
    expect(sandbox.calls.mergeCheck).toBe(2);
    expect(await store.listMergeChecks([item.id])).toEqual([expect.objectContaining({ mergeable: true, base_sha: "c".repeat(40) })]);
  });

  it("the base is fetched at most once per poll_interval_ms, however often it is refreshed", async () => {
    const { clock, controller, sandbox } = await counted();
    for (let i = 0; i < 5; i++) {
      await controller.tickMergeCheck();
      clock.advance(config.poll_interval_ms / 10);
    }
    expect(sandbox.calls.updateBase).toBe(1);
    clock.advance(config.poll_interval_ms);
    await controller.tickMergeCheck();
    await controller.tickMergeCheck();
    expect(sandbox.calls.updateBase).toBe(2);
  });

  it("a conflict enqueues one update run across repeated refreshes and the later GitHub change_unmergeable event", async () => {
    const { clock, controller, sandbox, store, item } = await counted();
    for (let i = 0; i < 3; i++) {
      await controller.tickMergeCheck();
      clock.advance(config.poll_interval_ms);
    }
    const head = "a".repeat(40);
    await controller.handleEvent({ kind: "change_unmergeable", change_ref: String(PR), head_branch: `factory/${item.id}`, head_sha: head, base_sha: sandbox.base });
    const runs = await updates(store, item.id);
    expect(runs.map((r) => r.idempotency_key)).toEqual([`${item.id}:update:${PR}:${head}:${sandbox.base}`]);
  });

  it("the GitHub event first, then the local check, still makes one update run", async () => {
    const { controller, sandbox, store, item } = await counted();
    const head = "a".repeat(40);
    await controller.handleEvent({ kind: "change_unmergeable", change_ref: String(PR), head_branch: `factory/${item.id}`, head_sha: head, base_sha: sandbox.base });
    await controller.tickMergeCheck();
    expect((await updates(store, item.id)).length).toBe(1);
    expect((await store.getMergeCheck(item.id))?.mergeable).toBe(false);
  });

  it("a refresh with unchanged shas enqueues nothing and cancels nothing", async () => {
    const { clock, controller, store, item } = await counted();
    await controller.tickMergeCheck();
    const runsBefore = await store.listRuns(item.id);
    const itemBefore = await store.getWorkItem(item.id);
    clock.advance(config.poll_interval_ms);
    await controller.tickMergeCheck();
    expect(await store.listRuns(item.id)).toEqual(runsBefore);
    expect(await store.getWorkItem(item.id)).toEqual(itemBefore);
  });

  it("works with no GitHub source configured", async () => {
    const { controller, store, item, source } = await counted({ source: new FakeSource("local") });
    expect(source.type).toBe("local");
    await controller.tickMergeCheck();
    expect(await store.getMergeCheck(item.id)).toMatchObject({ mergeable: false, conflicts: ["src/x.ts", "src/y.ts"] });
    expect((await updates(store, item.id)).length).toBe(1);
  });

  it("checks ready-to-merge items only", async () => {
    const { controller, store, sandbox } = await counted();
    const { item: other } = await store.createWorkItem(issue(2), system);
    const r = await store.transition({
      id: other.id, expected_version: other.version, actor: system, reason: "seed",
      patch: { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_conflict_pending", change_ref: "8" },
    });
    expect(r.ok).toBe(true);
    sandbox.heads[`factory/${other.id}`] = "d".repeat(40);
    await controller.tickMergeCheck();
    expect(await store.getMergeCheck(other.id)).toBeNull();
    expect(sandbox.calls.mergeCheck).toBe(1);
  });

  it("is off when the sandbox cannot check", async () => {
    const { store, controller } = await setup({ sandbox: new FakeSandbox() });
    const item = await readyItem(store, 1);
    await controller.tickMergeCheck();
    expect(await store.getMergeCheck(item.id)).toBeNull();
  });
});

/**
 * The counting sandbox with the local merge's probe: `localConflicts` reports `local` for every branch, and
 * `localBranch` reads `refs` (the factory repo's local branches; a forge selected reads them there).
 */
class LocalSandbox extends CountingSandbox {
  local: string[] = ["src/x.ts"];
  refs: Record<string, string | null> = {};
  probes = 0;
  localReads: string[] = [];
  async localBranch(spec: { repo: string; branch: string }): Promise<string | null> {
    this.localReads.push(spec.branch);
    return this.refs[spec.branch] ?? null;
  }
  async localConflicts(): Promise<string[] | null> {
    this.probes++;
    return this.local;
  }
  async mergeLocal(): Promise<never> {
    throw new Error("no merge in these tests");
  }
}

/** A local item (no PR) waiting for a merge, under a controller whose sandbox reads local refs (`local_only`). */
async function localItem(opts: { local_only?: boolean } = {}) {
  const sandbox = new LocalSandbox();
  const source = new FakeSource("local");
  const s = await setup({ sandbox, source, ...(opts.local_only === false ? { forge: new FakeForge(source) } : { local_only: true as const }) });
  const item = await readyItem(s.store, 1, "local", null);
  sandbox.heads[`factory/${item.id}`] = "a".repeat(40);
  const resolves = async () => (await s.store.listRuns(item.id)).filter((r) => r.kind === "resolve");
  const resolveEvent = (comment_id: string) =>
    ({ kind: "resolve_requested", source: item.source, comment_id, requester: alice, notes: "keep both", pr: null }) as const;
  return { ...s, sandbox, item, resolves, resolveEvent };
}

describe("merge check: a local item (no PR)", () => {
  it("a conflict with the moved local base starts one automatic resolve run, with no update run and no comment", async () => {
    const { clock, controller, sandbox, store, item, resolves } = await localItem();
    for (let i = 0; i < 3; i++) {
      await controller.tickMergeCheck();
      clock.advance(config.poll_interval_ms);
    }
    expect(await store.getWorkItem(item.id)).toMatchObject({ stage: "RUNNING", blocked_on: "none", blocked_reason: null, change_ref: null });
    expect((await resolves()).map((r) => [r.idempotency_key, r.status])).toEqual([[autoResolveKey(item.id, sandbox.base, 1), "queued"]]);
    expect(await updates(store, item.id)).toEqual([]);
    expect((await store.listStateChanges(item.id)).at(-1)).toMatchObject({
      reason: "auto_resolve_started", detail: { cause: "merge_check", base_sha: sandbox.base, attempt: 1, auto_resolve_attempts: 0 },
    });
    expect(await store.listItemMessages(item.id)).toEqual([]);
    expect(await store.getMergeCheck(item.id)).toMatchObject({ mergeable: false, head_sha: "a".repeat(40), base_sha: sandbox.base });
  });

  it("a clean local item waiting for a merge is untouched: no state change, no run, no comment", async () => {
    const { clock, controller, sandbox, store, item } = await localItem();
    sandbox.result = { mergeable: true, conflicts: [] };
    await controller.tickMergeCheck();
    clock.advance(config.poll_interval_ms);
    await controller.tickMergeCheck();
    expect(await store.getWorkItem(item.id)).toEqual(item);
    expect(await store.listRuns(item.id)).toEqual([]);
    expect(await store.listItemMessages(item.id)).toEqual([]);
    expect(sandbox.calls.mergeCheck).toBe(1);
  });

  it("with a forge selected, a conflict with the local base starts the automatic resolve keyed on the local base's commit; nothing is fetched for it", async () => {
    const { controller, sandbox, store, item, resolves } = await localItem({ local_only: false });
    const [main, head] = ["c".repeat(40), "d".repeat(40)];
    sandbox.refs = { main, [`factory/${item.id}`]: head };
    await controller.tickMergeCheck();
    await controller.tickMergeCheck();
    expect(sandbox.calls.fetchBranch).toBe(0);
    expect(sandbox.calls.mergeCheck).toBe(1);
    expect(sandbox.localReads).toEqual(expect.arrayContaining(["main", `factory/${item.id}`]));
    expect(await store.getWorkItem(item.id)).toMatchObject({ stage: "RUNNING", blocked_on: "none", change_ref: null });
    expect((await resolves()).map((r) => r.idempotency_key)).toEqual([autoResolveKey(item.id, main, 1)]);
    expect(await updates(store, item.id)).toEqual([]);
    expect((await store.listStateChanges(item.id)).at(-1)).toMatchObject({ reason: "auto_resolve_started", detail: { cause: "merge_check", base_sha: main, attempt: 1 } });
    expect(await store.getMergeCheck(item.id)).toMatchObject({ mergeable: false, head_sha: head, base_sha: main });
  });

  it("with a forge selected, a local item that merges cleanly runs no resolve and nothing changes", async () => {
    const { controller, sandbox, store, item } = await localItem({ local_only: false });
    sandbox.refs = { main: "c".repeat(40), [`factory/${item.id}`]: "d".repeat(40) };
    sandbox.result = { mergeable: true, conflicts: [] };
    await controller.tickMergeCheck();
    expect(await store.getWorkItem(item.id)).toEqual(item);
    expect(await store.listRuns(item.id)).toEqual([]);
    expect(await store.getMergeCheck(item.id)).toMatchObject({ mergeable: true });
  });

  it("with a forge selected, a local item with no local branch is not checked", async () => {
    const { controller, sandbox, store, item } = await localItem({ local_only: false });
    sandbox.refs = { main: "c".repeat(40) };
    await controller.tickMergeCheck();
    expect(sandbox.calls.mergeCheck).toBe(0);
    expect(await store.getMergeCheck(item.id)).toBeNull();
    expect(await store.getWorkItem(item.id)).toEqual(item);
  });

  it("with a forge selected, at the limit of 2 automatic resolve runs for the local base, the item waits on merge_conflict_pending", async () => {
    const { controller, sandbox, store, item, resolves } = await localItem({ local_only: false });
    const main = "c".repeat(40);
    sandbox.refs = { main, [`factory/${item.id}`]: "d".repeat(40) };
    let v = item.version;
    for (const attempt of [1, 2]) {
      const r = await store.transition({
        id: item.id, expected_version: v, patch: {}, actor: system, reason: "seed",
        enqueue: { kind: "resolve", idempotency_key: autoResolveKey(item.id, main, attempt) },
      });
      if (!r.ok) throw new Error(r.reason);
      v = r.item.version;
    }
    await controller.tickMergeCheck();
    expect(await store.getWorkItem(item.id)).toMatchObject({ stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_conflict_pending" });
    expect(await resolves()).toHaveLength(2);
    expect((await store.listStateChanges(item.id)).at(-1)).toMatchObject({ reason: "update_conflict", detail: { cause: "merge_check", auto_resolve_attempts: 2 } });
  });

  it("with a forge selected, a PR item's conflict still starts its update run, not a resolve", async () => {
    const sandbox = new LocalSandbox();
    const source = new FakeSource();
    const { controller, store } = await setup({ sandbox, source, forge: new FakeForge(source) });
    const pr = await readyItem(store, 2);
    sandbox.heads[`factory/${pr.id}`] = "a".repeat(40);
    await controller.tickMergeCheck();
    expect((await updates(store, pr.id)).map((r) => r.idempotency_key)).toEqual([`${pr.id}:update:${PR}:${"a".repeat(40)}:${sandbox.base}`]);
    expect((await store.listRuns(pr.id)).filter((r) => r.kind === "resolve")).toEqual([]);
    expect(sandbox.localReads).toEqual([]);
  });

  it("at the limit of 2 automatic resolve runs for the base, the item waits on merge_conflict_pending; the comment is on its thread", async () => {
    const { controller, sandbox, store, item, resolves } = await localItem();
    let v = item.version;
    for (const attempt of [1, 2]) {
      const r = await store.transition({
        id: item.id, expected_version: v, patch: {}, actor: system, reason: "seed",
        enqueue: { kind: "resolve", idempotency_key: autoResolveKey(item.id, sandbox.base, attempt) },
      });
      if (!r.ok) throw new Error(r.reason);
      v = r.item.version;
    }
    await controller.tickMergeCheck();
    expect(await store.getWorkItem(item.id)).toMatchObject({ stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_conflict_pending" });
    expect(await resolves()).toHaveLength(2);
    expect((await store.listStateChanges(item.id)).at(-1)).toMatchObject({ reason: "update_conflict", detail: { cause: "merge_check", auto_resolve_attempts: 2 } });
    const [note] = await store.listItemMessages(item.id);
    expect(note!.marker).toBe(`<!-- factory:auto-resolve-limit:${item.id}:${sandbox.base} -->`);
    expect(note!.body).toContain(`The local branch \`factory/${item.id}\` still conflicts`);
    expect(note!.body).not.toContain("PR #");
    expect((await store.listDeliveries(item.id)).filter((d) => /\/pull\//.test(d.target.link))).toEqual([]);
  });

  it("/resolve on a local item waiting for a merge whose branch conflicts starts a resolve run under a new key", async () => {
    const { controller, sandbox, store, item, resolves, resolveEvent } = await localItem();
    await controller.handleEvent(resolveEvent("c1"));
    expect(sandbox.probes).toBe(1);
    expect(await store.getWorkItem(item.id)).toMatchObject({ stage: "RUNNING", blocked_on: "none", restart_count: 1 });
    expect((await resolves()).map((r) => [r.idempotency_key, r.input])).toEqual([[`${item.id}:resolve:l0:r1`, { notes: "keep both" }]]);
    expect((await store.listStateChanges(item.id)).at(-1)).toMatchObject({ reason: "resolve_requested" });
  });

  it("/resolve on a local item waiting for a merge that merges cleanly is refused with the usual reply, and nothing changes", async () => {
    const { controller, sandbox, store, item, resolveEvent } = await localItem();
    sandbox.local = [];
    await controller.handleEvent(resolveEvent("c2"));
    expect(await store.getWorkItem(item.id)).toEqual(item);
    expect(await store.listRuns(item.id)).toEqual([]);
    const [reply] = await store.listItemMessages(item.id);
    expect(reply!.marker).toBe("<!-- factory:refused:c2 -->");
    expect(reply!.body).toContain("the item is not waiting on a merge conflict");
  });

  it("/resolve on a local item on merge_conflict_pending starts a resolve run under a new key each time", async () => {
    const { controller, store, item, resolves, resolveEvent } = await localItem();
    const pending = async () => {
      const cur = (await store.getWorkItem(item.id))!;
      const r = await store.transition({
        id: item.id, expected_version: cur.version, actor: system, reason: "seed",
        patch: { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_conflict_pending" },
      });
      if (!r.ok) throw new Error(r.reason);
    };
    await pending();
    await controller.handleEvent(resolveEvent("c3"));
    await pending();
    await controller.handleEvent(resolveEvent("c4"));
    expect((await resolves()).map((r) => r.idempotency_key)).toEqual([`${item.id}:resolve:l0:r1`, `${item.id}:resolve:l0:r2`]);
  });
});

describe("merge check: composition", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("build() passes the WorkerPool's sandbox instance to the Controller", async () => {
    const real = JSON.parse(readFileSync(join(import.meta.dirname, "..", "factory.config.json"), "utf8")) as Record<string, unknown>;
    const dir = mkdtempSync(join(tmpdir(), "sf-merge-compose-"));
    mkdirSync(join(dir, "prompts"));
    for (const p of ["triage", "implement", "review"]) writeFileSync(join(dir, "prompts", `${p}.md`), p);
    const plugins = { ...(real.plugins as object), awake: "none" };
    writeFileSync(join(dir, "factory.config.json"), JSON.stringify({ ...real, max_workers: undefined, store: { type: "sqlite" }, plugins, state_dir: "state", worktrees_dir: "wt" }));
    writeFileSync(join(dir, "secrets.env"), "GITHUB_TOKEN=gh\n");
    vi.stubEnv("SOFTWARE_FACTORY_SECRETS_FILE", join(dir, "secrets.env"));
    const built = await build(await loadConfig(dir), { clock: new FakeClock(), repoLookup: fakeRepoLookup });
    try {
      const controllerSandbox = built.controller.kernel.d.sandbox;
      const workerSandbox = (built.worker as unknown as { d: { sandbox: Sandbox } }).d.sandbox;
      expect(controllerSandbox).toBeDefined();
      expect(controllerSandbox).toBe(workerSandbox);
    } finally {
      await built.close();
    }
  });
});
