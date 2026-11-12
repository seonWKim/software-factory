import { OwnerAuth } from "../src/core/authorize.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { localProject } from "../src/compose.js";
import type { FactoryConfig } from "../src/core/config.js";
import { gitHost } from "../src/runtime/host-id.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import type { BaseSyncResult, BaseSyncSpec, LocalMergeResult, LocalMergeSpec } from "../src/core/local-merge.js";
import { runLocalCli } from "../src/core/local-cli.js";
import type { UserId, WorkItemId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { GitHubForge } from "../src/impl/github/github-forge.js";
import type { GitHubClient } from "../src/impl/github/github-client.js";
import { NoOpSandbox } from "../src/impl/sandbox/noop-sandbox.js";
import { LocalSource } from "../src/impl/source/local-source.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import type { BasePushInput, Forge } from "../src/interfaces/forge.js";
import type { Sandbox } from "../src/interfaces/sandbox.js";
import carry from "../src/outbound/migrations/20261109T1200-outbound-carry-base-pushes.migration.js";
import { actionOf } from "../src/outbound/intents.js";
import type { MigrationDb, SqlDriver } from "../src/state/index.js";
import { cleanScanner, config, silent } from "./helpers/fakes.js";
import { newStore, system, w1 } from "./helpers/store.js";

// The base push (design 05-sources, Local items; RFC 0015 M8): a merge delivered with a forge selected stores one
// keyed `push_base` action before it closes the item, to the base's destination; outbound's `local` target fetches
// the remote base, merges it when it moved, and pushes conditionally, retrying with its batch's backoff. With no
// forge nothing is stored and nothing remote is touched.

const ME = "local:me@example.com" as UserId;
const WHO = { provider: "local" as const, subject: "me@example.com" };
const SHA = (c: string) => c.repeat(40);
const T0 = "2026-11-08T10:00:00.000Z";
const project = localProject({ owner: "o", name: "r" });
const cfg: FactoryConfig = { ...config, project, local_only: true, repo: { ...config.repo, path: "/nowhere" } };

/** A sandbox that merges and syncs with no git: each call is recorded, and `sync` decides what the remote looks like. */
class FakeMergeSandbox {
  merges: LocalMergeSpec[] = [];
  syncs: BaseSyncSpec[] = [];
  sync: () => BaseSyncResult = () => ({ synced: true, local: SHA("b"), remote: SHA("0"), contains: false, not_updated: [] });
  async mergeLocal(spec: LocalMergeSpec): Promise<LocalMergeResult> {
    this.merges.push(spec);
    return { merged: true, sha: SHA("a"), already: false, not_updated: [] };
  }
  async localConflicts(): Promise<string[]> {
    return [];
  }
  async syncBase(spec: BaseSyncSpec): Promise<BaseSyncResult> {
    this.syncs.push(spec);
    return this.sync();
  }
}

/** A forge that only pushes a base: `fail` makes the next pushes throw, as a rate limit or an outage does. */
function fakeForge() {
  const pushes: BasePushInput[] = [];
  const state = { fail: null as string | null };
  const forge = {
    ref_type: "github_issue",
    async pushBase(input: BasePushInput) {
      pushes.push(input);
      if (state.fail) throw new Error(state.fail);
    },
  } as unknown as Forge;
  return { forge, pushes, state };
}

async function setup(opts: { forge?: Forge; store?: FactoryStore; clock?: FakeClock } = {}) {
  const clock = opts.clock ?? new FakeClock();
  const store = opts.store ?? (await newStore(clock)).store;
  const created = await runLocalCli(
    { store, identity: { user: ME, from: "git user.email" }, project: async () => project.key, read: async () => "b", newId: () => `id${Math.random()}` },
    { action: "create", title: "t", bodyFile: "b" },
  );
  const id = created.lines[0] as WorkItemId;
  const item = (await store.getWorkItem(id))!;
  const moved = await store.transition({
    id, expected_version: item.version, actor: system, reason: "review_passed",
    patch: { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending" },
  });
  if (!moved.ok) throw new Error("setup transition failed");
  const sandbox = new FakeMergeSandbox();
  const controller = replica(store, clock, sandbox, opts.forge);
  return { store, clock, sandbox, controller, id };
}

function replica(store: FactoryStore, clock: FakeClock, sandbox: FakeMergeSandbox, forge?: Forge, host?: { replica_id: string; git_host: { id: string; flush_all: boolean } }) {
  const auth = new OwnerAuth({ store: store, claimer: null });
  return new ControllerRole({
    store, sources: [new LocalSource(store)], auth, clock, config: cfg, log: silent, scanner: cleanScanner,
    sandbox: sandbox as unknown as Sandbox, repeated_failure_rule: false, ...(forge ? { forge } : {}), ...host,
  });
}

/** The item's base push action (RFC 0015 M8): delivered or not, and its outcome. */
async function basePush(f: Awaited<ReturnType<typeof setup>>) {
  const db = (f.store as unknown as { db: SqlDriver }).db;
  const rows = await db.all("SELECT * FROM outbound_actions WHERE action = 'push_base' AND work_item_id = ?", [f.id]);
  return rows.map((r) => {
    const a = actionOf(r);
    return { key: (r.intent_key as string | null) ?? null, target: a.target, args: a.args, delivered: a.delivered_at !== null, outcome: a.delivered_ref === null ? null : JSON.parse(a.delivered_ref) };
  });
}

/**
 * `factory merge` through the merge queue (RFC 0015 M8): the change enters, its merge-check run is completed green
 * as a worker would, and the run's result requests the merge of outbound. Applied alone, with no outbox step after
 * it, so nothing is merged yet.
 */
async function merge(f: Awaited<ReturnType<typeof setup>>): Promise<void> {
  expect(await f.controller.mergeLocal(f.id, WHO, "k")).toBeNull();
  const run = await f.store.claimRun({ worker_id: w1, kinds: ["merge-check"], lease_ms: 60_000 });
  expect(run?.kind).toBe("merge-check");
  await f.store.completeRun(run!.id, run!.lease!.token, { status: "succeeded", summary: "s", data: { result: "green", base_sha: SHA("0") } });
  const done = (await f.store.listRuns(f.id)).find((r) => r.id === run!.id)!;
  await (await f.controller.unit("run-results")).apply(done);
  expect(f.sandbox.merges).toEqual([]);
  expect(await f.store.getWorkItem(f.id)).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending" });
  // Outbound makes the merge; its DeliveryCompleted closes the item.
  await f.controller.tickOutbox();
  expect(f.sandbox.merges).toHaveLength(1);
}

describe("base push: queued by the merge's delivery, made by outbound's local target", () => {
  it("solo, no forge: the merge moves the local base and queues no push; nothing remote is called", async () => {
    const f = await setup();
    await merge(f);
    await f.controller.tickOutbox();
    expect(f.sandbox.merges).toHaveLength(1);
    expect(await f.store.getWorkItem(f.id)).toMatchObject({ stage: "CLOSED", close_reason: "completed", merge_sha: SHA("a") });
    expect(await basePush(f)).toEqual([]);
    expect(f.sandbox.syncs).toEqual([]);
    const reply = (await f.store.listItemMessages(f.id)).find((m) => m.marker.startsWith("<!-- factory:local-merged:"))!;
    expect(reply.body).toContain("no push");
  });

  it("with a forge: one keyed push to the base's destination; the item closes before it, so a failing push leaves it closed", async () => {
    const g = fakeForge();
    g.state.fail = "network unreachable";
    const f = await setup({ forge: g.forge });
    await merge(f);
    // Merged and closed, the push only stored: no fetch, no push yet.
    const closed = (await f.store.getWorkItem(f.id))!;
    expect(closed).toMatchObject({ stage: "CLOSED", close_reason: "completed", merge_sha: SHA("a") });
    expect(f.sandbox.syncs).toEqual([]);
    expect(g.pushes).toEqual([]);
    expect(await basePush(f)).toMatchObject([
      { key: `push_base:${f.id}:${SHA("a")}`, target: { type: "git", id: "local:main:push" }, args: { base_ref: "main", merge_sha: SHA("a") }, delivered: false },
    ]);

    await f.controller.tickOutbox();
    expect(g.pushes).toEqual([{ repo: "/nowhere", base_ref: "main", sha: SHA("b"), expected_sha: SHA("0") }]);
    expect(await basePush(f)).toMatchObject([{ delivered: false }]);
    // The item did not change at all.
    expect(await f.store.getWorkItem(f.id)).toEqual(closed);
  });

  it("a base push pending in the old table at upgrade becomes one keyed push_base action, and a solo controller built as compose builds it pushes it once", async () => {
    const g = fakeForge();
    const f = await setup({ forge: g.forge });
    const db = (f.store as unknown as { db: SqlDriver }).db;
    const insert = "INSERT INTO outbound_base_pushes (work_item_id, base_ref, merge_sha, next_attempt_at, finished_at, created_at) VALUES (?, ?, ?, ?, ?, ?)";
    await db.run(insert, [f.id, "main", SHA("a"), T0, null, T0]);
    const mdb: MigrationDb = { dialect: db.dialect.name, all: (q, p) => db.all(q, p), run: (q, p) => db.run(q, p) };
    await carry.up(mdb);
    await carry.up(mdb);
    expect(await basePush(f)).toMatchObject([
      { key: `push_base:${f.id}:${SHA("a")}`, target: { type: "git", id: "local:main:push" }, args: { base_ref: "main", merge_sha: SHA("a") }, delivered: false },
    ]);
    // As `factory controller` runs solo: a replica id and the state dir's host id, on the SQLite store.
    const stateDir = mkdtempSync(join(tmpdir(), "sf-state-"));
    const solo = replica(f.store, f.clock, f.sandbox, g.forge, { replica_id: `${hostname()}:4242`, git_host: gitHost(stateDir, "sqlite") });
    await solo.tickOutbox();
    expect(g.pushes).toHaveLength(1);
    expect(await basePush(f)).toMatchObject([{ delivered: true }]);
  });

  it("a replica on a shared store flushes the carried base pushes too (the `local` host's), beside its own host's", async () => {
    const g = fakeForge();
    const f = await setup({ forge: g.forge });
    const db = (f.store as unknown as { db: SqlDriver }).db;
    await db.run("INSERT INTO outbound_base_pushes (work_item_id, base_ref, merge_sha, next_attempt_at, finished_at, created_at) VALUES (?, ?, ?, ?, ?, ?)", [f.id, "main", SHA("a"), T0, null, T0]);
    await carry.up({ dialect: db.dialect.name, all: (q, p) => db.all(q, p), run: (q, p) => db.run(q, p) });
    const shared = replica(f.store, f.clock, f.sandbox, g.forge, { replica_id: "h1:1", git_host: { id: "h1", flush_all: false } });
    await shared.tickOutbox();
    expect(g.pushes).toHaveLength(1);
  });

  it("a failing base push holds no later merge on that base: the next item lands while the push retries", async () => {
    const g = fakeForge();
    g.state.fail = "git push failed: protected branch";
    const f = await setup({ forge: g.forge });
    await merge(f);
    await f.controller.tickOutbox();
    expect(g.pushes).toHaveLength(1);
    expect(await basePush(f)).toMatchObject([{ delivered: false }]);

    const next = await setup({ forge: g.forge, store: f.store, clock: f.clock });
    await merge(next);
    expect(await f.store.getWorkItem(next.id)).toMatchObject({ stage: "CLOSED", close_reason: "completed" });
  });

  it("a rate limit or outage keeps the push pending and retries it with backoff", async () => {
    const g = fakeForge();
    g.state.fail = "API rate limit exceeded";
    const f = await setup({ forge: g.forge });
    await merge(f);
    const closed = (await f.store.getWorkItem(f.id))!;
    await f.controller.tickOutbox();
    expect(g.pushes).toHaveLength(1);

    // Before the backoff ends nothing is tried.
    await f.controller.tickOutbox();
    expect(g.pushes).toHaveLength(1);
    f.clock.advance(cfg.retry_base_ms);
    await f.controller.tickOutbox();
    expect(g.pushes).toHaveLength(2);

    g.state.fail = null;
    f.clock.advance(cfg.retry_max_ms);
    await f.controller.tickOutbox();
    expect(g.pushes).toHaveLength(3);
    expect(await basePush(f)).toMatchObject([{ delivered: true, outcome: { pushed: SHA("b") } }]);
    expect(await f.store.getWorkItem(f.id)).toEqual(closed);
    // Delivered: never pushed again.
    f.clock.advance(cfg.retry_max_ms);
    await f.controller.tickOutbox();
    expect(g.pushes).toHaveLength(3);
  });

  it("a remote that already contains the merge is delivered with no push", async () => {
    const g = fakeForge();
    const f = await setup({ forge: g.forge });
    f.sandbox.sync = () => ({ synced: true, local: SHA("a"), remote: SHA("c"), contains: true, not_updated: [] });
    await merge(f);
    await f.controller.tickOutbox();
    expect(g.pushes).toEqual([]);
    expect(await basePush(f)).toMatchObject([{ delivered: true, outcome: { pushed: SHA("c") } }]);
  });

  it("a remote base conflict is delivered as a conflict; the item stays closed and gets one message to fix it by hand", async () => {
    const g = fakeForge();
    const f = await setup({ forge: g.forge });
    f.sandbox.sync = () => ({ synced: false, conflicts: ["a.txt", "src/c.txt"] });
    await merge(f);
    const closed = (await f.store.getWorkItem(f.id))!;
    await f.controller.tickOutbox();
    f.clock.advance(cfg.retry_max_ms);
    await f.controller.tickOutbox();

    expect(g.pushes).toEqual([]);
    expect(f.sandbox.syncs).toHaveLength(1);
    expect(await basePush(f)).toMatchObject([{ delivered: true, outcome: { conflicts: ["a.txt", "src/c.txt"] } }]);
    expect(await f.store.getWorkItem(f.id)).toEqual(closed);
    const notes = (await f.store.listItemMessages(f.id)).filter((m) => m.marker.startsWith("<!-- factory:base-push-conflict:"));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body).toContain("- `a.txt`");
    expect(notes[0]!.body).toContain("The item stays closed");
  });

  it("two replicas flushing at once push the base once", async () => {
    const g = fakeForge();
    const f = await setup({ forge: g.forge });
    await merge(f);
    const other = replica(f.store, f.clock, f.sandbox, g.forge);
    await Promise.all([f.controller.tickOutbox(), other.tickOutbox()]);
    expect(g.pushes).toHaveLength(1);
    expect(await basePush(f)).toMatchObject([{ delivered: true }]);
  });
});

// The git side against a bare repo standing in for the remote: the sandbox's fetch and merge, the forge's push.
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV }).trim();
const commit = (dir: string, file: string, text: string) => {
  writeFileSync(join(dir, file), `${text}\n`);
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", text);
};

function remoteSetup() {
  const root = mkdtempSync(join(tmpdir(), "sf-base-push-"));
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  const dev = join(root, "dev");
  git(root, "init", "--quiet", "--bare", "-b", "main", origin);
  git(root, "init", "--quiet", "-b", "main", repo);
  commit(repo, "README.md", "init");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "--quiet", "origin", "main");
  git(repo, "checkout", "--quiet", "--detach");
  git(root, "clone", "--quiet", origin, dev);
  // The local merge already happened: main is one commit ahead of origin.
  git(repo, "checkout", "--quiet", "main");
  commit(repo, "local.txt", "the local merge");
  git(repo, "checkout", "--quiet", "--detach");
  const merge_sha = git(repo, "rev-parse", "main");
  const sandbox = new NoOpSandbox(join(root, "wt"));
  const forge = new GitHubForge({} as GitHubClient, { owner: "o", name: "r" }, "factory/", "main", { postComment: async () => ({ url: null }), setStatus: async () => undefined });
  const spec = { repo, base_ref: "main", merge_sha, message: "Merge origin/main into main", identity: { name: "factory", email: "f@example.com" } };
  /** A person's push to the remote base from another clone. */
  const push = (file: string, text: string) => {
    git(dev, "pull", "--quiet", "--no-rebase", "origin", "main");
    commit(dev, file, text);
    git(dev, "push", "--quiet", "origin", "main");
    return git(dev, "rev-parse", "HEAD");
  };
  return { repo, origin, sandbox, forge, spec, merge_sha, push };
}

describe("base push: fetch, merge a moved remote base, conditional push (local bare remote)", { timeout: 60_000 }, () => {
  it("a remote base that moved is merged into the local base first, and the merge is pushed", async () => {
    const r = remoteSetup();
    const theirs = r.push("theirs.txt", "a person's change");
    const s = await r.sandbox.syncBase(r.spec);
    if (!s.synced) throw new Error("expected a clean sync");
    expect(s).toMatchObject({ remote: theirs, contains: false });
    expect(git(r.repo, "rev-parse", "main")).toBe(s.local);
    expect(git(r.repo, "rev-list", "--parents", "-n", "1", s.local).split(" ").slice(1)).toEqual([r.merge_sha, theirs]);

    await r.forge.pushBase({ repo: r.repo, base_ref: "main", sha: s.local, expected_sha: s.remote });
    expect(git(r.origin, "rev-parse", "main")).toBe(s.local);
    // Pushed: the next sync finds the merge on the remote.
    expect(await r.sandbox.syncBase(r.spec)).toMatchObject({ synced: true, contains: true });
  });

  it("a remote base that did not move is pushed as the local base", async () => {
    const r = remoteSetup();
    const before = git(r.origin, "rev-parse", "main");
    const s = await r.sandbox.syncBase(r.spec);
    expect(s).toMatchObject({ synced: true, local: r.merge_sha, remote: before, contains: false });
    await r.forge.pushBase({ repo: r.repo, base_ref: "main", sha: r.merge_sha, expected_sha: before });
    expect(git(r.origin, "rev-parse", "main")).toBe(r.merge_sha);
  });

  it("the push is conditional on the remote base read: one that moved again is not overwritten", async () => {
    const r = remoteSetup();
    const s = await r.sandbox.syncBase(r.spec);
    if (!s.synced) throw new Error("expected a clean sync");
    const again = r.push("late.txt", "pushed after the fetch");
    await expect(r.forge.pushBase({ repo: r.repo, base_ref: "main", sha: s.local, expected_sha: s.remote })).rejects.toThrow(/git push failed/);
    expect(git(r.origin, "rev-parse", "main")).toBe(again);
  });

  it("a remote base that does not merge cleanly moves nothing and names the files", async () => {
    const r = remoteSetup();
    r.push("local.txt", "their version");
    const s = await r.sandbox.syncBase(r.spec);
    expect(s).toEqual({ synced: false, conflicts: ["local.txt"] });
    expect(git(r.repo, "rev-parse", "main")).toBe(r.merge_sha);
  });
});
