// The local merge check (design §5 Merge check, issue #248): the controller checks each ready-to-merge factory PR
// against the newest base in the factory repo's object store, stores one latest result per item, and starts the
// update run at once on a conflict, keyed as GitHub's change_unmergeable path is. Real git repos for the git side;
// a counting sandbox for the call counts.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { build, loadConfig, localProject } from "../src/compose.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import type { SourceType, UserId, WorkerId, WorkItem, WorkItemId } from "../src/core/types.js";
import type { FactoryConfig } from "../src/core/config.js";
import { type CliAction, runLocalCli } from "../src/core/local-cli.js";
import { LocalAuthProvider } from "../src/impl/auth/local-auth-provider.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { LocalToolBroker } from "../src/impl/broker/local-tool-broker.js";
import { StaticGrant } from "../src/impl/grant/static.js";
import { LocalSource } from "../src/impl/source/local-source.js";
import { Worker } from "../src/worker/index.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { NoOpSandbox } from "../src/impl/sandbox/noop-sandbox.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import type { Sandbox } from "../src/interfaces/sandbox.js";
import { autoResolveKey } from "../src/core/policy.js";
import {
  FakeAuth, FakeRunner, FakeSandbox, FakeSource, MemoryStorage, alice, cleanScanner, config, fakeRepoLookup, pipeline, prompts, silent, triageSpec,
} from "./helpers/fakes.js";
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

async function setup(opts: { sandbox: Sandbox; repo?: string; source?: FakeSource; local_only?: true }) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const source = opts.source ?? new FakeSource();
  const cfg = { ...config, repo: { ...config.repo, path: opts.repo ?? "/repo" }, ...(opts.local_only ? { local_only: true as const } : {}) };
  const controller = new ControllerRole({ store, source, auth: new FakeAuth(), clock, config: cfg, log: silent, scanner: cleanScanner, sandbox: opts.sandbox });
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

/** The counting sandbox with the local merge's probe: `localConflicts` reports `local` for every branch. */
class LocalSandbox extends CountingSandbox {
  local: string[] = ["src/x.ts"];
  probes = 0;
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
  const s = await setup({ sandbox, source: new FakeSource("local"), ...(opts.local_only === false ? {} : { local_only: true as const }) });
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

  it("with a forge selected (not local_only) a local item is not checked: no fetch of a branch origin does not have", async () => {
    const { controller, sandbox, store, item } = await localItem({ local_only: false });
    await controller.tickMergeCheck();
    expect(sandbox.calls.fetchBranch).toBe(0);
    expect(await store.getMergeCheck(item.id)).toBeNull();
    expect(await store.getWorkItem(item.id)).toEqual(item);
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

  async function mergeCheckRun(o: { ui_check?: typeof ui_check; changed: string[]; exits?: Record<string, number> }) {
    const repo = { ...config.repo, check_commands: [["npm", "run", "typecheck"], ["npm", "test"]], ...(o.ui_check ? { ui_check: o.ui_check } : {}) };
    const f = await pipeline({ config: { repo } });
    f.sandbox.changedFiles = o.changed;
    Object.assign(f.sandbox.exits, o.exits ?? {});
    const { item } = await f.store.createWorkItem(issue(7), system);
    const moved = await f.store.transition({
      id: item.id, expected_version: item.version, actor: system, reason: "test_setup", patch: {},
      enqueue: { kind: "merge-check", idempotency_key: "mc-1", input: { merge_check: { base_ref: "main", branches: [`factory/${item.id}`] } } },
    });
    if (!moved.ok) throw new Error("setup");
    expect(await f.w1.tick()).toBe(true);
    const run = (await f.runs(moved.item, "merge-check"))[0]!;
    const diffs = f.sandbox.gitCalls.filter((c) => c.startsWith("diff --name-only") && !c.includes("--diff-filter=U"));
    return { commands: f.sandbox.commands, diffs, outcome: run.outcome };
  }

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

  it("a failing UI check is a red result naming the command", async () => {
    const r = await mergeCheckRun({ ui_check, changed: ["web/a.css"], exits: { "npm run check:responsive": 1 } });
    expect(r.outcome).toMatchObject({ status: "succeeded", data: { result: "red", why: "checks", command: "npm run check:responsive" } });
  });

  it("a failing check stops the run before the UI check", async () => {
    const r = await mergeCheckRun({ ui_check, changed: ["web/a.css"], exits: { "npm test": 1 } });
    expect(r.commands).toEqual(["npm ci", "npm run typecheck", "npm test"]);
    expect(r.outcome).toMatchObject({ data: { result: "red", command: "npm test" } });
  });
});

// End to end over a real git repo (as tests/merge-queue-flow.test.ts): a local change to web/ whose merged commit fails
// the UI check leaves the merge queue, `main` does not move, and the item's thread names the check.
describe("merge queue: a failing UI check (real git)", { timeout: 120_000 }, () => {
  const ME = "local:me@example.com" as UserId;
  const ident = ["-c", "user.name=t", "-c", "user.email=t@example.com"];
  const sh = (cwd: string, ...args: string[]) => git(cwd, ...args).trim();

  it("keeps main where it was, removes the entry and names check:responsive in the thread", async () => {
    const root = mkdtempSync(join(tmpdir(), "sf-ui-check-"));
    const repo = join(root, "repo");
    sh(root, "init", "--quiet", "-b", "main", repo);
    // The UI check fails on any merged commit.
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "x", private: true, scripts: { "check:responsive": "exit 1" } }));
    sh(repo, "add", "-A");
    sh(repo, ...ident, "commit", "--quiet", "-m", "init");
    sh(repo, "checkout", "--quiet", "--detach");

    const project = localProject({ owner: "o", name: "r" });
    const pass = ["sh", "-c", "exit 0"];
    const cfg: FactoryConfig = {
      ...config, project, local_only: true, merge_queue_depth: 1,
      repo: { ...config.repo, path: repo, install_command: pass, test_command: pass, ui_check: { command: ["npm", "run", "check:responsive"], paths: ["web/", "src/ui/"] } },
    };
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const auth = new LocalAuthProvider(store, [new StaticGrant({ roles: {}, deny: {} })]);
    const sandbox = new NoOpSandbox(join(root, "wt"), undefined, undefined, { local: true });
    const controller = new ControllerRole({
      store, sources: [new LocalSource(store)], auth, local_auth: auth, clock, config: cfg, log: silent, scanner: cleanScanner, sandbox, repeated_failure_rule: false,
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
      log: silent, scanner: cleanScanner, toolEnv: { PATH: process.env.PATH ?? "", HOME: root, GIT_CONFIG_GLOBAL: "/dev/null" }, awake: new NoKeepAwake(),
    });
    const step = async () => {
      await controller.tickIntake();
      while (await worker.tick()) await controller.tickRuns();
      await controller.tickRuns();
    };
    let n = 0;
    const cli = (a: CliAction) =>
      runLocalCli({ store, identity: { user: ME, from: "git user.email" }, project: async () => project.key, read: async () => "the body", newId: () => `id${++n}` }, a);

    const id = (await cli({ action: "create", title: "Web change", bodyFile: "body.md" })).lines[0] as WorkItemId;
    await step();
    await cli({ action: "command", command: "approve", id, text: "" });
    await step();
    await step();
    expect(await store.getWorkItem(id)).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending" });
    const mainBefore = sh(repo, "rev-parse", "main");

    await cli({ action: "command", command: "merge", id, text: "" });
    await step();

    expect(sh(repo, "rev-parse", "main")).toBe(mainBefore);
    expect(await store.getWorkItem(id)).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending", merge_sha: null });
    const queue = await controller.unit("merge-queue");
    expect((await queue.entries(id)).map((e) => e.state)).toEqual(["removed"]);
    const check = (await store.listRuns(id)).find((r) => r.kind === "merge-check")!;
    expect(check.outcome).toMatchObject({ status: "succeeded", data: { result: "red", command: "npm run check:responsive" } });
    const refused = (await store.listItemMessages(id)).filter((m) => m.marker.startsWith("<!-- factory:refused:")).map((m) => m.body);
    expect(refused.join("\n")).toContain("`npm run check:responsive`");
    expect(refused.join("\n")).toContain("did not move and the change left the merge queue");
  });
});
