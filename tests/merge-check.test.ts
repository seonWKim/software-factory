// The local merge check (design §5 Merge check, issue #248): the controller checks each ready-to-merge factory PR
// against the newest base in the factory repo's object store, stores one latest result per item, and starts the
// update run at once on a conflict, keyed as GitHub's change_unmergeable path is. Real git repos for the git side;
// a counting sandbox for the call counts.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { build } from "../src/compose.js";
import { loadConfig, localProject } from "../src/load-config.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import type { SourceType, UserId, WorkerId, WorkItem, WorkItemId } from "../src/core/types.js";
import { MODE_KEY, SELECTION_ACTOR, type SelectionRecord, cleanCursor } from "../src/core/test-selection.js";
import type { FactoryConfig } from "../src/core/config.js";
import { type CliAction, runLocalCli } from "../src/core/local-cli.js";
import { OwnerAuth } from "../src/core/authorize.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { LocalToolBroker } from "../src/impl/broker/local-tool-broker.js";
import { LocalSource } from "../src/impl/source/local-source.js";
import { Worker } from "../src/worker/index.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { NoOpSandbox } from "../src/impl/sandbox/noop-sandbox.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import type { Sandbox } from "../src/interfaces/sandbox.js";
import type { EgressScanner } from "../src/interfaces/egress-scanner.js";
import { autoResolveKey } from "../src/core/policy.js";
import { NODE_PROBE, offNode, onNode } from "../src/worker/runs/merge-check/node-version.js";
import { JDK_PROBE } from "../src/worker/runs/merge-check/jdk-version.js";
import { FakeAuth, FakeRunner, FakeSandbox, MemoryStorage } from "./helpers/fakes/runner.js";
import { FakeForge } from "./helpers/fakes/forge.js";
import { FakeSource } from "./helpers/fakes/source.js";
import { alice, cleanScanner, config, fakeRepoLookup, prompts, silent, triageSpec } from "./helpers/fakes/config.js";
import { pipeline } from "./helpers/harness.js";
import { issue, newStore, system } from "./helpers/store.js";
import { answersDetail, splitAnswers } from "../src/shared/command-notes.js";

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
 * `localBranch` reads `locals` (the factory repo's local branches; a forge selected reads them there).
 */
class LocalSandbox extends CountingSandbox {
  local: string[] = ["src/x.ts"];
  locals: Record<string, string | null> = {};
  probes = 0;
  localReads: string[] = [];
  async localBranch(spec: { repo: string; branch: string }): Promise<string | null> {
    this.localReads.push(spec.branch);
    return this.locals[spec.branch] ?? null;
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
    sandbox.locals = { main, [`factory/${item.id}`]: head };
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
    sandbox.locals = { main: "c".repeat(40), [`factory/${item.id}`]: "d".repeat(40) };
    sandbox.result = { mergeable: true, conflicts: [] };
    await controller.tickMergeCheck();
    expect(await store.getWorkItem(item.id)).toEqual(item);
    expect(await store.listRuns(item.id)).toEqual([]);
    expect(await store.getMergeCheck(item.id)).toMatchObject({ mergeable: true });
  });

  it("with a forge selected, a local item with no local branch is not checked", async () => {
    const { controller, sandbox, store, item } = await localItem({ local_only: false });
    sandbox.locals = { main: "c".repeat(40) };
    await controller.tickMergeCheck();
    expect(sandbox.calls.mergeCheck).toBe(0);
    expect(await store.getMergeCheck(item.id)).toBeNull();
    expect(await store.getWorkItem(item.id)).toEqual(item);
  });

  it("with a forge selected, at the limit of 2 automatic resolve runs for the local base, the item waits on merge_conflict_pending", async () => {
    const { controller, sandbox, store, item, resolves } = await localItem({ local_only: false });
    const main = "c".repeat(40);
    sandbox.locals = { main, [`factory/${item.id}`]: "d".repeat(40) };
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

// The UI check at merge (design §4, issue: run check:responsive at merge, not in the sandbox): a merge-check run whose
// merged result changes a path under `repo.ui_check.paths` runs `repo.ui_check.command` after the install command and
// the checks; one that does not, or with no `repo.ui_check`, runs nothing more.
describe("merge check run: the UI check (fake sandbox)", () => {
  const ui_check = { command: ["npm", "run", "check:responsive"], paths: ["web/", "src/ui/"] };

  /** `ui`: the UI check's reply in the merged checkout (the first) and in the base's (the second): an exit and output, or a throw. */
  type UiReply = { exit: number; out?: string } | "throw";
  async function mergeCheckRun(o: { ui_check?: typeof ui_check; check_tz?: string; changed: string[]; exits?: Record<string, number>; ui?: { merged: UiReply; base?: UiReply } }) {
    const repo = {
      ...config.repo, check_commands: [["npm", "run", "typecheck"], ["npm", "test"]], ...(o.ui_check ? { ui_check: o.ui_check } : {}), ...(o.check_tz ? { check_tz: o.check_tz } : {}),
    };
    const f = await pipeline({ config: { repo } });
    f.sandbox.changedFiles = o.changed;
    Object.assign(f.sandbox.exits, o.exits ?? {});
    const exec = f.sandbox.exec.bind(f.sandbox);
    const handles: string[] = [];
    const tz: [string, string | undefined][] = []; // each non-git command and the TZ it ran with
    f.sandbox.exec = async (h, cmd, eo) => {
      if (cmd[0] !== "git") tz.push([cmd.join(" "), eo.env?.TZ]);
      const r = await exec(h, cmd, eo);
      if (!handles.includes(h.id)) handles.push(h.id);
      if (!o.ui || cmd.join(" ") !== "npm run check:responsive") return r;
      const reply = handles.indexOf(h.id) === 0 ? o.ui.merged : (o.ui.base ?? { exit: 0 });
      if (reply === "throw") throw new Error("spawn npm ENOENT");
      return { ...r, exit_code: reply.exit, stdout: reply.out ?? "" };
    };
    const { item } = await f.store.createWorkItem(issue(7), system);
    const moved = await f.store.transition({
      id: item.id, expected_version: item.version, actor: system, reason: "test_setup", patch: {},
      enqueue: { kind: "merge-check", idempotency_key: "mc-1", input: { merge_check: { base_ref: "main", branches: [`factory/${item.id}`] } } },
    });
    if (!moved.ok) throw new Error("setup");
    expect(await f.w1.tick()).toBe(true);
    const run = (await f.runs(moved.item, "merge-check"))[0]!;
    const diffs = f.sandbox.gitCalls.filter((c) => c.startsWith("diff --name-only") && !c.includes("--diff-filter=U"));
    const data = run.outcome?.status === "succeeded" ? run.outcome.data : {};
    return { commands: f.sandbox.commands, diffs, outcome: run.outcome, data, created: f.sandbox.created, gitCalls: f.sandbox.gitCalls, destroyed: f.sandbox.destroyed, tz };
  }

  it("with repo.check_tz, the install command, the checks, the UI check and its base rerun all run with TZ set to that zone", async () => {
    const r = await mergeCheckRun({ ui_check, check_tz: "UTC", changed: ["web/a.css"], ui: { merged: { exit: 1 } } });
    const all = ["npm ci", "npm run typecheck", "npm test", "npm run check:responsive", "npm ci", "npm run check:responsive"];
    expect(r.commands).toEqual(all);
    expect(r.tz.filter(([c]) => all.includes(c))).toEqual(all.map((c) => [c, "UTC"]));
  });

  it("with no repo.check_tz, no merge-check command gets a TZ variable and the result is unchanged", async () => {
    const r = await mergeCheckRun({ ui_check, changed: ["web/a.css"] });
    expect(r.commands).toEqual(["npm ci", "npm run typecheck", "npm test", "npm run check:responsive"]);
    expect(r.tz.every(([, zone]) => zone === undefined)).toBe(true);
    expect(r.outcome).toMatchObject({ status: "succeeded", data: { result: "green" } });
  });

  it("a merged result touching web/ runs the UI check after the install command and the checks", async () => {
    const r = await mergeCheckRun({ ui_check, changed: ["README.md", "web/src/App.tsx"] });
    expect(r.commands).toEqual(["npm ci", "npm run typecheck", "npm test", "npm run check:responsive"]);
    expect(r.diffs).toEqual([expect.stringMatching(/^diff --name-only -z --no-renames \S+ \S+$/)]);
    expect(r.outcome).toMatchObject({ status: "succeeded", data: { result: "green" } });
  });

  it("a merged result touching src/ui/ runs it too", async () => {
    const r = await mergeCheckRun({ ui_check, changed: ["src/ui/page.ts"] });
    expect(r.commands.at(-1)).toBe("npm run check:responsive");
  });

  it("a merged result touching neither web/ nor src/ui/ does not run the UI check", async () => {
    const r = await mergeCheckRun({ ui_check, changed: ["src/core/policy.ts", "webby.md", "docs/web/x.md"] });
    expect(r.commands).toEqual(["npm ci", "npm run typecheck", "npm test"]);
    expect(r.outcome).toMatchObject({ status: "succeeded", data: { result: "green" } });
  });

  it("with no repo.ui_check, no extra command runs and the changed files are not read", async () => {
    const r = await mergeCheckRun({ changed: ["web/src/App.tsx"] });
    expect(r.commands).toEqual(["npm ci", "npm run typecheck", "npm test"]);
    expect(r.diffs).toEqual([]);
  });

  it("a failing UI check runs once more on the base alone, in a fresh checkout at the base; a base that passes leaves the change's red result", async () => {
    const out = " FAIL  tests/ui.test.ts > page > layout\nlayout broken at 375px\n";
    const r = await mergeCheckRun({ ui_check, changed: ["web/a.css"], ui: { merged: { exit: 1, out } } });
    expect(r.commands).toEqual(["npm ci", "npm run typecheck", "npm test", "npm run check:responsive", "npm ci", "npm run check:responsive"]);
    expect(r.created.map((c) => [c.branch, c.base_ref])).toEqual([[null, "main"], [null, "main"]]);
    expect(r.gitCalls.filter((c) => c.includes("checkout --quiet --detach"))).toEqual([expect.stringMatching(/checkout --quiet --detach base$/)]);
    expect(r.destroyed).toBe(2);
    expect(r.outcome).toMatchObject({
      status: "succeeded",
      data: { result: "red", why: "checks", command: "npm run check:responsive", how: "exited 1", failing_tests: ["tests/ui.test.ts > page > layout"], output_tail: out },
    });
  });

  it("a UI check that fails on the base too is red with why base_red, the command and the base's output tail", async () => {
    const r = await mergeCheckRun({ ui_check, changed: ["web/a.css"], ui: { merged: { exit: 1, out: "merged\n" }, base: { exit: 1, out: "main is broken\n" } } });
    expect(r.outcome).toMatchObject({
      status: "succeeded", data: { result: "red", why: "base_red", command: "npm run check:responsive", how: "exited 1", output_tail: "main is broken\n", base_sha: "base" },
    });
  });

  it("a UI-check failure with no output keeps its reason as the tail: a command that could not run, or its exit", async () => {
    const thrown = await mergeCheckRun({ ui_check, changed: ["web/a.css"], ui: { merged: "throw" } });
    expect(thrown.data).toMatchObject({ result: "red", why: "checks", how: "could not run: spawn npm ENOENT", output_tail: "could not run: spawn npm ENOENT" });
    const silentExit = await mergeCheckRun({ ui_check, changed: ["web/a.css"], ui: { merged: { exit: 1 }, base: { exit: 2 } } });
    expect(silentExit.data).toMatchObject({ result: "red", why: "base_red", how: "exited 2", output_tail: "exited 2" });
  });

  it("a failing check stops the run before the UI check", async () => {
    const r = await mergeCheckRun({ ui_check, changed: ["web/a.css"], exits: { "npm test": 1 } });
    expect(r.commands).toEqual(["npm ci", "npm run typecheck", "npm test"]);
    expect(r.outcome).toMatchObject({ data: { result: "red", command: "npm test" } });
  });
});

// A failing check on the merged result names its failing tests (`file > name`, at most MAX_FAILING_TESTS, as the
// implement run parses them) and keeps the output tail (at most CHECK_TAIL_CHARS), scanned first: a flagged tail is
// withheld whole, the names are kept.
describe("merge check run: a failing check names its tests and keeps the output tail (fake sandbox)", () => {
  const fails = (n: number) => Array.from({ length: n }, (_, i) => ` FAIL  tests/t${i}.test.ts > suite > case ${i}`).join("\n");
  const printed = { "npm test": `${"x".repeat(3000)}\n${fails(12)}\n Test Files  12 failed\n` };

  async function failingRun(scanner?: EgressScanner) {
    const repo = { ...config.repo, check_commands: [["npm", "test"]] };
    const f = await pipeline({ config: { repo }, ...(scanner ? { scanner } : {}) });
    const exec = f.sandbox.exec.bind(f.sandbox);
    // `npm test` fails, and so does its one rerun on the failing files (`npm test -- tests/t0.test.ts ...`).
    f.sandbox.exec = async (h, cmd, eo) => {
      const r = await exec(h, cmd, eo);
      return cmd.slice(0, 2).join(" ") === "npm test" ? { ...r, exit_code: 1, stdout: printed["npm test"] } : r;
    };
    const { item } = await f.store.createWorkItem(issue(7), system);
    const moved = await f.store.transition({
      id: item.id, expected_version: item.version, actor: system, reason: "test_setup", patch: {},
      enqueue: { kind: "merge-check", idempotency_key: "mc-1", input: { merge_check: { base_ref: "main", branches: [`factory/${item.id}`] } } },
    });
    if (!moved.ok) throw new Error("setup");
    expect(await f.w1.tick()).toBe(true);
    return (await f.runs(moved.item, "merge-check"))[0]!.outcome;
  }

  it("the red outcome holds the failing test names, at most 10, and the last 2000 characters of the output", async () => {
    const outcome = await failingRun();
    expect(outcome).toMatchObject({ status: "succeeded", data: { result: "red", why: "checks", command: "npm test", how: "exited 1" } });
    const data = outcome?.status === "succeeded" ? outcome.data : {};
    expect(data.failing_tests).toEqual(Array.from({ length: 10 }, (_, i) => `tests/t${i}.test.ts > suite > case ${i}`));
    expect(typeof data.output_tail).toBe("string");
    expect((data.output_tail as string).length).toBe(2000);
    expect(data.output_tail).toContain("Test Files  12 failed");
  });

  it("a tail the egress scan flags is withheld whole; the names are kept", async () => {
    const flagTail: EgressScanner = {
      scan: async (channel, text) => (text.includes("Test Files") && !text.startsWith("{") ? { clean: false, findings: [{ rule: "test_leak", channel }] } : { clean: true }),
    };
    const outcome = await failingRun(flagTail);
    expect(outcome).toMatchObject({ status: "succeeded", data: { result: "red", why: "checks", output_tail: null } });
    const data = outcome?.status === "succeeded" ? outcome.data : {};
    expect(data.failing_tests).toContain("tests/t0.test.ts > suite > case 0");
  });
});

// A failing check list whose output names failing test files reruns only those files once, with the same command
// (design §4). A passing rerun is green, listing the flaky tests, and the list goes on; a failing rerun, one that
// cannot start, or a failure naming no test file stays red with the first failure. The install command and the UI
// check are never rerun.
describe("merge check run: one rerun of the failing test files (fake sandbox)", () => {
  const FAIL = " FAIL  tests/a.test.ts > suite > flaky\n FAIL  tests/b.test.ts > other > case\n";
  type Reply = { exit: number; out?: string } | "throw";

  /**
   * Each command's replies by its argv joined with spaces, one per call in order (then exit 0). `selection`: the
   * item's selection before push, recorded on an earlier finished run, with the project's mode set to `mode`.
   */
  async function rerunRun(replies: Record<string, Reply[]>, o: { ui?: true; selection?: SelectionRecord; mode?: "enforce" } = {}) {
    const repo = {
      ...config.repo, check_commands: [["npm", "test"], ["npm", "run", "lint"]],
      ...(o.ui ? { ui_check: { command: ["npm", "run", "check:responsive"], paths: ["web/"] } } : {}),
    };
    const f = await pipeline({ config: { repo } });
    f.sandbox.changedFiles = ["web/a.css"];
    const exec = f.sandbox.exec.bind(f.sandbox);
    f.sandbox.exec = async (h, cmd, eo) => {
      const r = await exec(h, cmd, eo);
      const reply = replies[cmd.join(" ")]?.shift();
      if (reply === "throw") throw new Error("spawn ENOENT");
      return reply === undefined ? r : { ...r, exit_code: reply.exit, stdout: reply.out ?? "" };
    };
    let { item } = await f.store.createWorkItem(issue(7), system);
    if (o.selection) {
      const queued = await f.store.transition({ id: item.id, expected_version: item.version, actor: system, reason: "test_setup", patch: {}, enqueue: { kind: "triage", idempotency_key: "t-1" } });
      if (!queued.ok) throw new Error("setup");
      item = queued.item;
      const run = (await f.store.claimRun({ worker_id: "earlier" as WorkerId, kinds: ["triage"], lease_ms: 60_000 }))!;
      await f.store.completeRun(run.id, run.lease!.token, { status: "succeeded", summary: "s", data: { test_selection: o.selection } });
    }
    if (o.mode) {
      await f.store.setLearnedSetting({ project: item.project, key: MODE_KEY, expected: null, value: JSON.stringify(o.mode), evidence_run_ids: [], window_end: "2025-12-31T00:00:00.000Z" as never, actor: SELECTION_ACTOR });
    }
    const moved = await f.store.transition({
      id: item.id, expected_version: item.version, actor: system, reason: "test_setup", patch: {},
      enqueue: { kind: "merge-check", idempotency_key: "mc-1", input: { merge_check: { base_ref: "main", branches: [`factory/${item.id}`] } } },
    });
    if (!moved.ok) throw new Error("setup");
    expect(await f.w1.tick()).toBe(true);
    const outcome = (await f.runs(moved.item, "merge-check"))[0]!.outcome;
    return { commands: f.sandbox.commands, outcome, data: outcome?.status === "succeeded" ? outcome.data : {}, store: f.store, item };
  }

  it("a fail-then-pass test file is rerun alone, the list goes on, and the green result lists the flaky tests", async () => {
    const r = await rerunRun({ "npm test": [{ exit: 1, out: FAIL }] });
    expect(r.commands).toEqual(["npm ci", "npm test", "npm test -- tests/a.test.ts tests/b.test.ts", "npm run lint"]);
    expect(r.outcome).toMatchObject({ status: "succeeded", data: { result: "green" } });
    expect(r.data.flaky_tests).toEqual(["tests/a.test.ts > suite > flaky", "tests/b.test.ts > other > case"]);
  });

  it("a green result with no rerun lists no flaky tests", async () => {
    const r = await rerunRun({});
    expect(r.outcome).toMatchObject({ status: "succeeded", data: { result: "green" } });
    expect(r.data).not.toHaveProperty("flaky_tests");
  });

  it("a rerun that fails too stays red with the failing tests named, and nothing more runs", async () => {
    const r = await rerunRun({ "npm test": [{ exit: 1, out: FAIL }], "npm test -- tests/a.test.ts tests/b.test.ts": [{ exit: 1, out: FAIL }] });
    expect(r.commands).toEqual(["npm ci", "npm test", "npm test -- tests/a.test.ts tests/b.test.ts"]);
    expect(r.outcome).toMatchObject({ status: "succeeded", data: { result: "red", why: "checks", command: "npm test", how: "exited 1" } });
    expect(r.data.failing_tests).toEqual(["tests/a.test.ts > suite > flaky", "tests/b.test.ts > other > case"]);
    expect(r.data).not.toHaveProperty("flaky_tests");
  });

  // Test selection's revert (design §4, shadow mode): the list above runs whole in every mode.
  it("a failing file the item's enforced selection left out is a miss: named on the red result, and the mode goes back to shadow", async () => {
    const failing = { "npm test": [{ exit: 1, out: FAIL }], "npm test -- tests/a.test.ts tests/b.test.ts": [{ exit: 1, out: FAIL }] };
    const enforced: SelectionRecord = { mode: "enforce", full: false, files: ["tests/a.test.ts"], reason: "1 files" };
    const r = await rerunRun(failing, { selection: enforced, mode: "enforce" });
    expect(r.commands).toEqual(["npm ci", "npm test", "npm test -- tests/a.test.ts tests/b.test.ts"]);
    expect(r.data).toMatchObject({ result: "red", why: "checks", selection_miss: ["tests/b.test.ts"] });
    expect(await r.store.getLearnedSetting(r.item.project, MODE_KEY)).toMatchObject({ value: '"shadow"' });
    expect((await r.store.listLearnedSettingChanges(10)).map((c) => [c.key, c.old_value, c.new_value, c.actor])).toEqual([
      [MODE_KEY, '"enforce"', '"shadow"', SELECTION_ACTOR], [MODE_KEY, null, '"enforce"', SELECTION_ACTOR],
    ]);
    expect(await r.store.getCursor(cleanCursor(r.item.project))).toBeNull();

    // A selection made in shadow mode ran the whole command before push: its files decide nothing at the merge check.
    const shadow = await rerunRun(failing, { selection: { ...enforced, mode: "shadow" }, mode: "enforce" });
    expect(shadow.data).not.toHaveProperty("selection_miss");
    expect(await shadow.store.getLearnedSetting(shadow.item.project, MODE_KEY)).toMatchObject({ value: '"enforce"' });
  });

  it("a failure naming no test file is not rerun and stays red", async () => {
    const r = await rerunRun({ "npm test": [{ exit: 2, out: "Error: config not found\n" }] });
    expect(r.commands).toEqual(["npm ci", "npm test"]);
    expect(r.outcome).toMatchObject({ status: "succeeded", data: { result: "red", command: "npm test", how: "exited 2", failing_tests: [] } });
  });

  it("a rerun that cannot start is red with the first failure", async () => {
    const r = await rerunRun({ "npm test": [{ exit: 1, out: FAIL }], "npm test -- tests/a.test.ts tests/b.test.ts": ["throw"] });
    expect(r.commands).toEqual(["npm ci", "npm test", "npm test -- tests/a.test.ts tests/b.test.ts"]);
    expect(r.outcome).toMatchObject({ status: "succeeded", data: { result: "red", command: "npm test", how: "exited 1" } });
    expect(r.data.failing_tests).toEqual(["tests/a.test.ts > suite > flaky", "tests/b.test.ts > other > case"]);
  });

  it("the install command and the UI check are not rerun, even when their output names a test file", async () => {
    const install = await rerunRun({ "npm ci": [{ exit: 1, out: FAIL }] });
    expect(install.commands).toEqual(["npm ci"]);
    expect(install.outcome).toMatchObject({ data: { result: "red", command: "npm ci" } });
    const ui = await rerunRun({ "npm run check:responsive": [{ exit: 1, out: FAIL }] }, { ui: true });
    // The UI check's one more run is on the base alone (after its install command), never a rerun of test files.
    expect(ui.commands).toEqual(["npm ci", "npm test", "npm run lint", "npm run check:responsive", "npm ci", "npm run check:responsive"]);
    expect(ui.outcome).toMatchObject({ data: { result: "red", command: "npm run check:responsive" } });
  });
});

// Install and checks run on the project's Node major (.nvmrc, else package.json engines), as CI does, not on the
// worker's own Node. The runtime lookup is the fake sandbox's reply to the probe command: no Node is installed and no
// network is used. A Node that is not there fails the run with checks_env naming it; it never passes on another one.
describe("merge check run: the project's Node version (fake sandbox, fake runtime)", () => {
  type Files = { ".nvmrc"?: string; "package.json"?: string; ".java-version"?: string; "build.gradle"?: string; "build.gradle.kts"?: string };

  /**
   * `files`: the merged commit's files; `probe`: what the runtime lookup prints; `exits`: replies by command;
   * `jdk`: what the JDK probe prints on stderr (java writes its version there).
   */
  async function nodeRun(files: Files, probe: string, exits: Record<string, { exit: number; out?: string }[]> = {}, jdk = "") {
    const repo = { ...config.repo, check_commands: [["npm", "run", "typecheck"], ["npm", "test"]] };
    const f = await pipeline({ config: { repo } });
    const exec = f.sandbox.exec.bind(f.sandbox);
    const argvs: string[][] = [];
    const probes: string[][] = [];
    const jdkProbes: string[][] = [];
    f.sandbox.exec = async (h, cmd, eo) => {
      const r = await exec(h, cmd, eo);
      const read = cmd[0] === "git" && cmd[1] === "cat-file" ? /:(.+)$/.exec(cmd.at(-1)!)?.[1] : undefined;
      if (read !== undefined) {
        const text = files[read as keyof Files];
        return text === undefined ? { ...r, exit_code: 128, stderr: `fatal: path '${read}' does not exist` } : { ...r, stdout: text };
      }
      if (cmd[0] === "sh" && cmd[2] === NODE_PROBE) {
        probes.push([...cmd]);
        return { ...r, stdout: probe };
      }
      if (cmd[0] === "sh" && cmd[2] === JDK_PROBE) {
        jdkProbes.push([...cmd]);
        return { ...r, stderr: jdk };
      }
      if (cmd[0] === "git") return r;
      argvs.push([...cmd]);
      const reply = exits[offNode(cmd).join(" ")]?.shift();
      return reply ? { ...r, exit_code: reply.exit, stdout: reply.out ?? "" } : r;
    };
    const { item } = await f.store.createWorkItem(issue(7), system);
    const moved = await f.store.transition({
      id: item.id, expected_version: item.version, actor: system, reason: "test_setup", patch: {},
      enqueue: { kind: "merge-check", idempotency_key: "mc-1", input: { merge_check: { base_ref: "main", branches: [`factory/${item.id}`] } } },
    });
    if (!moved.ok) throw new Error("setup");
    expect(await f.w1.tick()).toBe(true);
    const outcome = (await f.runs(moved.item, "merge-check"))[0]!.outcome;
    return { argvs, probes, jdkProbes, outcome };
  }

  const project = ["npm ci", "npm run typecheck", "npm test"];
  const NODE22 = "/fake/nvm/versions/node/v22.13.0/bin";

  it("with .nvmrc 22 and a Node 25 worker, install and every check run on the Node 22 install the lookup found", async () => {
    const r = await nodeRun({ ".nvmrc": "22\n" }, `current=v25.3.0\nfound=/fake/nvm/versions/node/v22.1.0/bin\nfound=${NODE22}\n`);
    expect(r.probes.map((p) => p.at(-1))).toEqual(["22"]);
    expect(r.argvs.map((c) => offNode(c).join(" "))).toEqual(project);
    for (const c of r.argvs) expect(onNode({ bin: NODE22, version: "v22" }, offNode(c))).toEqual(c);
    expect(r.argvs.every((c) => c.includes(NODE22))).toBe(true);
    expect(r.outcome).toMatchObject({ status: "succeeded", data: { result: "green", node: "Node v22 (.nvmrc)" } });
  });

  it("the wrapper puts the chosen Node's folder first on PATH and runs the project's command as it is", () => {
    const cmd = onNode({ bin: NODE22, version: "v22" }, ["npm", "test"]);
    const out = execFileSync(cmd[0]!, [...cmd.slice(1, 4), "sh", "-c", 'printf "%s|%s" "${PATH%%:*}" "$1"', "x", "arg"], { encoding: "utf8" });
    expect(out).toBe(`${NODE22}|arg`);
    expect(offNode(cmd)).toEqual(["npm", "test"]);
    expect(onNode({ bin: null, version: "v22.13.0" }, ["npm", "test"])).toEqual(["npm", "test"]);
  });

  it("with .nvmrc 22 and a worker already on Node 22, the commands run as they are", async () => {
    const r = await nodeRun({ ".nvmrc": "v22.13.0\n" }, "current=v22.13.0\n");
    expect(r.argvs.map((c) => c.join(" "))).toEqual(project);
    expect(r.outcome).toMatchObject({ status: "succeeded", data: { result: "green", node: "Node v22.13.0 (.nvmrc)" } });
  });

  it("with .nvmrc 22 and no Node 22 installed, the run fails with checks_env naming the version needed and the one found", async () => {
    const r = await nodeRun({ ".nvmrc": "22\n" }, "current=v25.3.0\n");
    expect(r.argvs).toEqual([]);
    expect(r.outcome).toMatchObject({ status: "failed", error_code: "checks_env" });
    const detail = r.outcome?.status === "failed" ? r.outcome.detail : "";
    expect(detail).toContain("Node 22 (from .nvmrc)");
    expect(detail).toContain("found Node v25.3.0");
  });

  it("a missing Node with no node on the worker at all says so", async () => {
    const r = await nodeRun({ ".nvmrc": "22" }, "current=\n");
    expect(r.outcome).toMatchObject({ status: "failed", error_code: "checks_env" });
    expect(r.outcome?.status === "failed" ? r.outcome.detail : "").toContain("found no Node");
  });

  it("with no .nvmrc, the major comes from package.json engines", async () => {
    const r = await nodeRun({ "package.json": JSON.stringify({ engines: { node: ">=22.13" } }) }, "current=v25.3.0\n");
    expect(r.probes.map((p) => p.at(-1))).toEqual(["22"]);
    expect(r.outcome).toMatchObject({ status: "failed", error_code: "checks_env" });
    expect(r.outcome?.status === "failed" ? r.outcome.detail : "").toContain("Node 22 (from package.json engines)");
  });

  it("an .nvmrc naming no major (lts/*) falls back to package.json engines", async () => {
    const r = await nodeRun({ ".nvmrc": "lts/*\n", "package.json": JSON.stringify({ engines: { node: "^22" } }) }, "current=v22.2.0\n");
    expect(r.probes.map((p) => p.at(-1))).toEqual(["22"]);
    expect(r.outcome).toMatchObject({ status: "succeeded", data: { node: "Node v22.2.0 (package.json engines)" } });
  });

  it("with neither file naming a version, the checks run on the worker's Node and the result says so", async () => {
    const r = await nodeRun({ "package.json": JSON.stringify({ name: "x" }) }, "current=v25.3.0\n");
    expect(r.probes).toEqual([]);
    expect(r.argvs.map((c) => c.join(" "))).toEqual(project);
    expect(r.outcome).toMatchObject({ status: "succeeded", data: { result: "green", node: expect.stringContaining("the worker's Node") } });
  });

  it("a failing check on the chosen Node is named by the project's command, and its rerun runs on that Node too", async () => {
    const FAIL = " FAIL  tests/a.test.ts > suite > case\n";
    const r = await nodeRun({ ".nvmrc": "22" }, `current=v25.3.0\nfound=${NODE22}\n`, {
      "npm test": [{ exit: 1, out: FAIL }], "npm test -- tests/a.test.ts": [{ exit: 1, out: FAIL }],
    });
    expect(r.argvs.map((c) => offNode(c).join(" "))).toEqual([...project, "npm test -- tests/a.test.ts"]);
    expect(r.argvs.every((c) => c.includes(NODE22))).toBe(true);
    expect(r.outcome).toMatchObject({ status: "succeeded", data: { result: "red", why: "checks", command: "npm test", node: "Node v22 (.nvmrc)" } });
  });

  // The JDK pin: the wanted major from .java-version, else the root Gradle toolchain; the found one from the worker's
  // java. Another major, or none, is checks_env naming both, before install runs; a project naming no JDK reads none.
  const JDK17 = 'current=openjdk version "17.0.2" 2022-01-18';
  const JDK21 = 'current=openjdk version "21.0.1" 2023-10-17';

  it("with .java-version 17 and a JDK 21 worker, the run fails with checks_env naming both majors", async () => {
    const r = await nodeRun({ ".java-version": "17\n" }, "", {}, `${JDK21}\n`);
    expect(r.argvs).toEqual([]);
    expect(r.outcome).toMatchObject({ status: "failed", error_code: "checks_env" });
    const detail = r.outcome?.status === "failed" ? r.outcome.detail : "";
    expect(detail).toContain("JDK 17 (from .java-version)");
    expect(detail).toContain("found JDK 21");
  });

  it("with the worker's JDK on the wanted major, install and checks run as before", async () => {
    const r = await nodeRun({ ".java-version": "temurin-17.0.2\n" }, "", {}, `${JDK17}\n`);
    expect(r.jdkProbes.length).toBeGreaterThan(0);
    expect(r.argvs.map((c) => c.join(" "))).toEqual(project);
    expect(r.outcome).toMatchObject({ status: "succeeded", data: { result: "green" } });
  });

  it("a project with no .java-version and no Gradle toolchain reads no JDK", async () => {
    const r = await nodeRun({ "build.gradle": "plugins { id 'java' }\n" }, "", {}, "current=\n");
    expect(r.jdkProbes).toEqual([]);
    expect(r.argvs.map((c) => c.join(" "))).toEqual(project);
    expect(r.outcome).toMatchObject({ status: "succeeded", data: { result: "green" } });
  });

  it("a failing test on the right JDK is still a red check, not checks_env", async () => {
    const r = await nodeRun({ ".java-version": "17" }, "", { "npm test": [{ exit: 1, out: "BUILD FAILED\n" }] }, `${JDK17}\n`);
    expect(r.outcome).toMatchObject({ status: "succeeded", data: { result: "red", why: "checks", command: "npm test" } });
  });

  it("with no .java-version, the major comes from the root Gradle toolchain (build.gradle, then build.gradle.kts)", async () => {
    const groovy = await nodeRun({ "build.gradle": "java { toolchain { languageVersion = JavaLanguageVersion.of(17) } }" }, "", {}, `${JDK21}\n`);
    expect(groovy.outcome).toMatchObject({ status: "failed", error_code: "checks_env" });
    expect(groovy.outcome?.status === "failed" ? groovy.outcome.detail : "").toContain("JDK 17 (from build.gradle)");
    const kts = await nodeRun({ "build.gradle.kts": "java { toolchain { languageVersion.set(JavaLanguageVersion.of(21)) } }" }, "", {}, `${JDK17}\n`);
    expect(kts.outcome?.status === "failed" ? kts.outcome.detail : "").toContain("JDK 21 (from build.gradle.kts)");
    const first = await nodeRun({ ".java-version": "21", "build.gradle": "JavaLanguageVersion.of(17)" }, "", {}, `${JDK21}\n`);
    expect(first.outcome).toMatchObject({ status: "succeeded", data: { result: "green" } });
  });

  it("a wanted JDK on a worker with no JDK fails with checks_env saying no JDK was found", async () => {
    const r = await nodeRun({ ".java-version": "17" }, "", {}, "current=sh: java: not found\n");
    expect(r.argvs).toEqual([]);
    expect(r.outcome).toMatchObject({ status: "failed", error_code: "checks_env" });
    const detail = r.outcome?.status === "failed" ? r.outcome.detail : "";
    expect(detail).toContain("JDK 17 (from .java-version)");
    expect(detail).toContain("found no JDK");
  });
});

// End to end over a real git repo (as tests/merge-queue-flow.test.ts). A local change to web/ whose merged commit fails
// the UI check while `main` alone passes it leaves the merge queue, `main` does not move, the item's thread names the
// check, and the item goes back to implement as a loop with the output tail kept. When `main` alone fails it too (red
// main, design 03-risk), no change is blamed: the entries stay queued and are not checked again until `main` moves,
// and one red_main alert and one fix item are stored for that base sha.
describe("merge queue: a failing UI check (real git)", { timeout: 120_000 }, () => {
  const ME = "local:me@example.com" as UserId;
  const ident = ["-c", "user.name=t", "-c", "user.email=t@example.com"];
  const sh = (cwd: string, ...args: string[]) => git(cwd, ...args).trim();

  /**
   * A local factory over a real repo whose `check:responsive` script is `script`; `depth`: the merge queue's depth.
   * `o.test`: the test command (default: passes); `o.check_tz`: repo.check_tz; `o.machine_tz`: the worker's own TZ.
   */
  async function uiFactory(script: string, depth = 1, o: { test?: string[]; check_tz?: string; machine_tz?: string } = {}) {
    const root = mkdtempSync(join(tmpdir(), "sf-ui-check-"));
    const repo = join(root, "repo");
    sh(root, "init", "--quiet", "-b", "main", repo);
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "x", private: true, scripts: { "check:responsive": script } }));
    sh(repo, "add", "-A");
    sh(repo, ...ident, "commit", "--quiet", "-m", "init");
    sh(repo, "checkout", "--quiet", "--detach");

    const project = localProject({ owner: "o", name: "r" });
    const pass = ["sh", "-c", "exit 0"];
    const cfg: FactoryConfig = {
      ...config, project, local_only: true, merge_queue_depth: depth,
      repo: {
        ...config.repo, path: repo, install_command: pass, test_command: o.test ?? pass, ui_check: { command: ["npm", "run", "check:responsive"], paths: ["web/", "src/ui/"] },
        ...(o.check_tz ? { check_tz: o.check_tz } : {}),
      },
    };
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const auth = new OwnerAuth(store);
    const sandbox = new NoOpSandbox(join(root, "wt"), undefined, undefined, { local: true });
    const controller = new ControllerRole({
      store, sources: [new LocalSource(store)], auth, clock, config: cfg, log: silent, scanner: cleanScanner, sandbox, repeated_failure_rule: false,
    });
    const runner = new FakeRunner({
      triage: () => ({ output: { ...triageSpec, allowed_paths: ["web/"], files_to_change: ["web/app.css"] } }),
      implement: (spec) => {
        mkdirSync(join(spec.sandbox.workdir, "web"), { recursive: true });
        writeFileSync(join(spec.sandbox.workdir, "web", "app.css"), "body {}\n");
        sh(spec.sandbox.workdir, "add", "-A");
        sh(spec.sandbox.workdir, ...ident, "commit", "--quiet", "-m", "web change");
        return { output: { summary: "web change", next_steps: "none" } };
      },
      review: () => ({ output: { verdict: "pass", tier: 2, findings: [], summary: "s" } }),
    });
    const broker = new LocalToolBroker({ store, scanner: cleanScanner, branchPrefix: cfg.branch_prefix, repoPath: repo });
    const worker = new Worker({
      id: "w1" as WorkerId, store, sandbox, runner, broker, storage: new MemoryStorage(), clock, config: cfg, prompts,
      log: silent, scanner: cleanScanner, toolEnv: { PATH: process.env.PATH ?? "", HOME: root, GIT_CONFIG_GLOBAL: "/dev/null", ...(o.machine_tz ? { TZ: o.machine_tz } : {}) },
      awake: new NoKeepAwake(),
    });
    const step = async () => {
      await controller.tickIntake();
      while (await worker.tick()) await controller.tickRuns();
      await controller.tickRuns();
    };
    let n = 0;
    const cli = (a: CliAction) =>
      runLocalCli({ answers: { split: splitAnswers, detail: answersDetail }, store, identity: { user: ME, from: "git user.email" }, project: async () => project.key, read: async () => "the body", newId: () => `id${++n}` }, a);
    /** A change to web/ reviewed and waiting for its merge. */
    const ready = async (title: string) => {
      const id = (await cli({ action: "create", title, bodyFile: "body.md" })).lines[0] as WorkItemId;
      await step();
      await cli({ action: "command", command: "approve", id, text: "" });
      await step();
      await step();
      expect(await store.getWorkItem(id)).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending" });
      return id;
    };
    const merge = (id: WorkItemId) => cli({ action: "command", command: "merge", id, text: "" });
    return { root, repo, store, controller, step, ready, merge };
  }

  it("main passes alone: keeps main where it was, removes the entry, names check:responsive in the thread and sends the item back with the tail", async () => {
    // The UI check fails only on a commit with the change's web/app.css: `main` alone passes it.
    const f = await uiFactory("test ! -e web/app.css || { echo web/app.css breaks the layout; exit 1; }");
    const id = await f.ready("Web change");
    const mainBefore = sh(f.repo, "rev-parse", "main");

    await f.merge(id);
    await f.step();

    expect(sh(f.repo, "rev-parse", "main")).toBe(mainBefore);
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "RUNNING", loop_count: 1, merge_sha: null });
    const queue = await f.controller.unit("merge-queue");
    expect((await queue.entries(id)).map((e) => e.state)).toEqual(["removed"]);
    const check = (await f.store.listRuns(id)).find((r) => r.kind === "merge-check")!;
    expect(check.outcome).toMatchObject({ status: "succeeded", data: { result: "red", why: "checks", command: "npm run check:responsive" } });
    const failed = (await f.store.listStateChanges(id)).find((c) => c.reason === "merge_check_failed");
    expect(failed?.detail).toMatchObject({ command: "npm run check:responsive", output_tail: expect.stringContaining("web/app.css breaks the layout") });
    const refused = (await f.store.listItemMessages(id)).filter((m) => m.marker.startsWith("<!-- factory:refused:")).map((m) => m.body);
    expect(refused.join("\n")).toContain("`npm run check:responsive`");
    expect(refused.join("\n")).toContain("did not move and the change left the merge queue");
    expect((await f.store.listAlerts({ limit: 10 })).some((a) => a.pattern === "red_main")).toBe(false);
  });

  // The red-main incident of 2026-11-22 (fixed by wi_74ef152e): a fixture window of exactly one UTC day. 20:00Z on
  // 2026-11-22 is already 2026-11-23 in Asia/Seoul, so this test passes on the owner's machine and fails under UTC.
  const oneUtcDay = ["node", "-e", "process.exit(new Date('2026-11-22T20:00:00Z').getDate() === 23 ? 0 : 1)"];

  it("repo.check_tz UTC on an Asia/Seoul machine: a test that passes only outside UTC passes the implement checks and turns the merge check red", async () => {
    const f = await uiFactory("exit 0", 1, { test: oneUtcDay, check_tz: "UTC", machine_tz: "Asia/Seoul" });
    const id = await f.ready("Web change");
    const mainBefore = sh(f.repo, "rev-parse", "main");

    await f.merge(id);
    await f.step();

    expect(sh(f.repo, "rev-parse", "main")).toBe(mainBefore);
    const check = (await f.store.listRuns(id)).find((r) => r.kind === "merge-check")!;
    expect(check.outcome).toMatchObject({ status: "succeeded", data: { result: "red", why: "checks", command: oneUtcDay.join(" ") } });
  });

  it("with no repo.check_tz, the same test on the same machine passes the merge check: nothing changes", async () => {
    const f = await uiFactory("exit 0", 1, { test: oneUtcDay, machine_tz: "Asia/Seoul" });
    const id = await f.ready("Web change");

    await f.merge(id);
    await f.step();

    const check = (await f.store.listRuns(id)).find((r) => r.kind === "merge-check")!;
    expect(check.outcome).toMatchObject({ status: "succeeded", data: { result: "green" } });
  });

  it("main fails alone: the queued changes stay queued with no loop, one red_main alert and one fix item for the base sha, and no check again until main moves", async () => {
    const f = await uiFactory("echo main is broken; exit 1", 2);
    const first = await f.ready("Web change one");
    const second = await f.ready("Web change two");
    const main = sh(f.repo, "rev-parse", "main");

    await f.merge(first);
    await f.merge(second);
    await f.step();

    const queue = await f.controller.unit("merge-queue");
    for (const id of [first, second]) {
      expect(sh(f.repo, "rev-parse", "main")).toBe(main);
      expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "REVIEW", loop_count: 0, merge_sha: null });
      expect((await queue.entries(id)).map((e) => e.state)).toEqual(["queued"]);
      expect((await f.store.listStateChanges(id)).map((c) => c.reason)).not.toContain("merge_check_failed");
      const check = (await f.store.listRuns(id)).find((r) => r.kind === "merge-check")!;
      expect(check.outcome).toMatchObject({
        status: "succeeded", data: { result: "red", why: "base_red", command: "npm run check:responsive", base_sha: main, output_tail: expect.stringContaining("main is broken") },
      });
    }
    // Both changes failed on the same base: one alert and one fix item, keyed on its sha.
    const alerts = async () => (await f.store.listAlerts({ limit: 50 })).filter((a) => a.pattern === "red_main");
    expect((await alerts()).map((a) => a.pattern_key)).toEqual([`red_main:${main}`]);
    // Manual mode: the alert is raised, and there is no auto mode to stop.
    expect((await f.store.listAlerts({ limit: 50 })).some((a) => a.pattern === "auto_stopped")).toBe(false);
    expect((await f.store.listSettingChanges(50)).filter((c) => c.key === "mode")).toEqual([]);
    const fixes = async () => (await f.store.db.all("SELECT intent_key FROM outbound_actions WHERE action = 'file_fix_item'")).map((r) => r.intent_key);
    expect(await fixes()).toEqual([`file_fix_item:red_main:${main}`]);
    await f.controller.tickOutbox();
    const filedId = `local-filed-${createHash("sha256").update(`<!-- factory:red-main:${main} -->`).digest("hex").slice(0, 16)}`;
    const filed = await f.store.getWorkItemBySource("local", filedId);
    expect(filed).toMatchObject({ requester_id: "system:controller" });
    expect(filed!.title).toContain(main.slice(0, 12));

    // Held while main is unchanged: more ticks run no check and store nothing more.
    const checks = async () => (await Promise.all([first, second].map((id) => f.store.listRuns(id)))).flat().filter((r) => r.kind === "merge-check").length;
    const before = await checks();
    await queue.queueStep();
    await f.step();
    await queue.queueStep();
    expect(await checks()).toBe(before);
    expect(await alerts()).toHaveLength(1);
    expect(await fixes()).toHaveLength(1);
    expect((await queue.entries(first)).map((e) => e.state)).toEqual(["queued"]);

    // `main` moves: the head entry is checked again.
    sh(f.repo, "checkout", "--quiet", "main");
    writeFileSync(join(f.repo, "fix.txt"), "a fix\n");
    sh(f.repo, "add", "-A");
    sh(f.repo, ...ident, "commit", "--quiet", "-m", "a fix");
    sh(f.repo, "checkout", "--quiet", "--detach");
    await queue.queueStep();
    expect(await checks()).toBeGreaterThan(before);
  });
});
