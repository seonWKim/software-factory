import { OwnerAuth } from "../src/core/authorize.js";
// The local store is the home of the conversation (issue #284): the GitHub poll writes each new comment once to its
// item's thread and each command once to the command inbox, keyed on the GitHub comment id, and the controller
// applies GitHub commands from the inbox through the GitHub auth provider. Factory messages still reach GitHub
// through the outbox only, once per marker.

import { describe, expect, it } from "vitest";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { type CliAction, type LocalCliDeps, runLocalCli } from "../src/core/local-cli.js";
import type { UserId, WorkerId, WorkItem, WorkItemId } from "../src/core/types.js";
import { Worker } from "../src/worker/index.js";
import { GitHubAuthProvider } from "../src/impl/github/github-auth-provider.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { GitHubError } from "../src/impl/github/github-client.js";
import { GitHubIssueSource } from "../src/impl/github/github-issue-source.js";
import { LocalSource } from "../src/impl/source/local-source.js";
import { parseComment } from "../src/core/commands.js";
import type { AuthProvider } from "../src/interfaces/auth-provider.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import {
  FakeBroker, FakeGitHubClient, FakeRunner, FakeSandbox, MemoryStorage, cleanScanner, config, issueRef, prompts, recordingLog, triageSpec,
} from "./helpers/fakes.js";
import { PROJECT_KEY, newStore } from "./helpers/store.js";

const OWNER = "github:1" as UserId;
const ME = "local:me@example.com" as UserId;
const alice = { id: 1, login: "alice", type: "User" };
const mallory = { id: 666, login: "mallory", type: "User" };

interface Comment {
  id: number;
  issue_url: string;
  html_url: string;
  body: string;
  user: typeof alice;
  updated_at: string;
}

/**
 * GitHub repo o/r in memory: the factory-labelled open issues, the repository's comment list (what the source polls),
 * PRs, and the routes the factory writes (each issue's comments, labels, reactions; FakeGitHubClient).
 */
class Hub extends FakeGitHubClient {
  open: { number: number; title: string; body: string; user: typeof alice; updated_at: string }[] = [];
  polled: Comment[] = [];
  pulls = new Map<number, { number: number; head: { ref: string } }>();
  /** When set, every call fails with it, as an outage or a rate limit does. */
  down: Error | null = null;

  override async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (this.down) {
      this.calls.push(`FAILED ${method} ${path.split("?")[0]}`);
      throw this.down;
    }
    const [bare, query = ""] = path.split("?") as [string, string?];
    const firstPage = !/(^|&)page=([2-9]|\d\d)/.test(query);
    if (method === "GET" && bare === "/repos/o/r/issues") {
      this.calls.push(`GET ${bare}?state=${query.includes("state=open") ? "open" : "closed"}`);
      return (firstPage && query.includes("state=open") ? this.open : []) as T;
    }
    if (method === "GET" && bare === "/repos/o/r/issues/comments") {
      this.calls.push(`GET ${bare}`);
      return (firstPage ? this.polled : []) as T;
    }
    if (method === "GET" && (bare === "/repos/o/r/commits" || /\/(sub_issues|dependencies\/blocked_by)$/.test(bare))) {
      this.calls.push(`GET ${bare}`);
      return [] as T;
    }
    let m = /^\/repos\/o\/r\/pulls\/(\d+)$/.exec(bare);
    if (method === "GET" && m) {
      this.calls.push(`GET ${bare}`);
      const pr = this.pulls.get(Number(m[1]));
      if (!pr) throw new GitHubError(404, `GitHub GET ${bare} → 404`);
      return pr as T;
    }
    m = /^\/repos\/o\/r\/issues\/(\d+)$/.exec(bare);
    if (method === "GET" && m) {
      this.calls.push(`GET ${bare}`);
      return { body: "", ...(this.pulls.has(Number(m[1])) ? { pull_request: {} } : {}) } as T;
    }
    if (method === "POST" && /\/reactions$/.test(bare)) {
      this.calls.push(`POST ${bare}`);
      return {} as T;
    }
    return super.request<T>(method, path, body);
  }

  /** A comment by `user` on issue (or PR conversation) `n`, as the repository's comment list returns it. */
  comment(n: number, id: number, body: string, o: { user?: typeof alice; onPr?: boolean; updated_at?: string } = {}): void {
    this.polled.push({
      id, body, user: o.user ?? alice, updated_at: o.updated_at ?? `2026-11-07T00:00:${String(id % 60).padStart(2, "0")}Z`,
      issue_url: `https://api.github.com/repos/o/r/issues/${n}`,
      html_url: `https://github.com/o/r/${o.onPr ? "pull" : "issues"}/${n}#issuecomment-${id}`,
    });
  }

  /** The comments the factory posted on issue `n` (each issue's own comment route). */
  postedOn(n: number): string[] {
    return (this.comments.get(n) ?? []).map((c) => c.body);
  }
}

/** The local auth plugin, recording every identity and principal it is asked about. */
function spied(inner: AuthProvider): AuthProvider & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    resolve: (i) => (asked.push(`${i.provider}:${i.subject}`), inner.resolve(i)),
    authorize: (p, a, r) => (asked.push(p.user_id), inner.authorize(p, a, r)),
  };
}

/** One owner (design 08-permissions): ME, the CLI identity, with the GitHub account OWNER names linked to it. */
async function ownedBy(store: FactoryStore): Promise<void> {
  if (await store.getLocalUser(ME)) return;
  await store.claimLocalOwner(ME);
  await store.createLinkCode(ME, "OWNERLINK1");
  await store.redeemLinkCode("OWNERLINK1", { provider: "github", subject: OWNER.slice("github:".length) });
}


async function factory(o: { store?: FactoryStore; clock?: FakeClock } = {}) {
  const clock = o.clock ?? new FakeClock("2026-11-07T00:00:00Z");
  const store = o.store ?? (await newStore(clock)).store;
  const hub = new Hub();
  const source = new GitHubIssueSource(hub, { owner: "o", name: "r" }, "factory", "factory/", "main", "sf: ", store);
  // One owner: the GitHub account and the CLI identity are the same factory user (the account is linked to it).
  await ownedBy(store);
  const local_auth = spied(new OwnerAuth(store));
  const log = recordingLog();
  const controller = new ControllerRole({
    store, sources: [source, new LocalSource(store)], auth: local_auth, clock, config, log, scanner: cleanScanner, repeated_failure_rule: false,
  });
  const runner = new FakeRunner({
    triage: () => ({ output: triageSpec }),
    implement: () => ({ output: { summary: "the summary", next_steps: "the next steps" } }),
    review: () => ({ output: { verdict: "pass", tier: 2, findings: [], summary: "s" } }),
  });
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox: new FakeSandbox(), runner, broker: new FakeBroker(), storage: new MemoryStorage(), clock, config,
    prompts, log, scanner: cleanScanner, toolEnv: {}, awake: new NoKeepAwake(),
  });
  const step = async () => {
    await controller.tickIntake();
    while (await worker.tick()) await controller.tickRuns();
    await controller.tickRuns();
  };
  let n = 0;
  // Each fixture its own terminal: command keys never collide across replicas on one store.
  const terminal = Math.random().toString(36).slice(2, 8);
  const cli = (user: UserId, a: CliAction) => {
    const d: LocalCliDeps = {
      store, identity: { user, from: "git user.email" }, project: async () => PROJECT_KEY, read: async () => "the body", newId: () => `${terminal}-${++n}`,
    };
    return runLocalCli(d, a);
  };
  /** Issue `n`, factory-labelled, taken in and triaged: its spec waits for approval. */
  const specced = async (num = 7): Promise<WorkItem> => {
    hub.open.push({ number: num, title: "Add a scope gate", body: "the body", user: alice, updated_at: "2026-11-07T00:00:00Z" });
    await step();
    const it = (await store.getWorkItemBySource("github_issue", issueRef(num).id))!;
    expect(it).toMatchObject({ stage: "READY", blocked_reason: "spec_pending" });
    return it;
  };
  const githubRows = async () => (await store.listCliCommandsAfter(0, 1000)).filter((c) => c.key.startsWith("github:"));
  const thread = async (id: WorkItemId) => (await store.listItemMessages(id)).map((m): [string, string] => [m.marker, m.body]);
  return { clock, store, hub, source, controller, worker, local_auth, log, step, cli, specced, githubRows, thread };
}

describe("GitHub comments in the local store (issue #284)", () => {
  it("a command comment is stored once in the inbox and once in the item thread; a repeat poll or a second replica writes nothing more", async () => {
    const f = await factory();
    const item = await f.specced();
    const before = await f.store.getCursor("intake:github_issue");
    f.hub.comment(7, 101, "/approve looks good");
    await f.controller.tickIntake();

    const rows = await f.githubRows();
    expect(rows).toEqual([expect.objectContaining({
      key: "github:101", actor: "github:1", command: "approve", args: { source: issueRef(7), text: "looks good" },
    })]);
    expect((await f.thread(item.id)).filter(([m]) => m === "github:101")).toEqual([["github:101", "/approve looks good"]]);
    expect(await f.store.getWorkItem(item.id)).toMatchObject({ stage: "RUNNING" });

    // The next poll reads the same comment again (`since` is inclusive), and a second replica polls from the
    // cursor the first one read before it moved: neither writes a second row or entry.
    await f.controller.tickIntake();
    const replica = new GitHubIssueSource(f.hub, { owner: "o", name: "r" }, "factory", "factory/", "main", "sf: ", f.store);
    // It re-lists the open issue (intake is idempotent), and returns no comment event.
    expect((await replica.poll(before)).events.filter((e) => e.kind !== "item_requested")).toEqual([]);
    expect(await f.githubRows()).toHaveLength(1);
    expect((await f.thread(item.id)).filter(([m]) => m === "github:101")).toHaveLength(1);
    // Applied once: one approval.
    expect((await f.store.listStateChanges(item.id)).filter((c) => c.reason === "spec_approved")).toHaveLength(1);
  });

  it("stores the numeric user id only: no login in the command row, the thread or the item", async () => {
    const f = await factory();
    const item = await f.specced();
    f.hub.comment(7, 101, "/revise keep the existing flag");
    f.hub.comment(7, 102, "thanks, that reads well");
    await f.controller.tickIntake();
    expect((await f.githubRows()).map((r) => r.actor)).toEqual(["github:1"]);
    const stored = JSON.stringify([await f.githubRows(), await f.store.listItemMessages(item.id), await f.store.getWorkItem(item.id)]);
    expect(stored).not.toContain("alice");
  });

  it("applies one poll's commands in comment-id order, whatever order GitHub lists them in", async () => {
    const f = await factory();
    const item = await f.specced();
    // Listed by updated_at: the later comment (an edit) first.
    f.hub.comment(7, 111, "/approve", { updated_at: "2026-11-07T00:00:01Z" });
    f.hub.comment(7, 110, "/revise split it in two", { updated_at: "2026-11-07T00:00:02Z" });
    await f.controller.tickIntake();
    expect((await f.githubRows()).map((r) => r.key)).toEqual(["github:110", "github:111"]);
    // The revise went first, so the approval found no spec waiting and changed nothing.
    const reasons = (await f.store.listStateChanges(item.id)).map((c) => c.reason);
    expect(reasons).toContain("spec_revision_requested");
    expect(reasons).not.toContain("spec_approved");
  });

  it("a plain comment on an issue is written once to the item thread and changes no state", async () => {
    const f = await factory();
    const item = await f.specced();
    const changes = (await f.store.listStateChanges(item.id)).length;
    f.hub.comment(7, 120, "could this also cover the CLI?");
    await f.controller.tickIntake();
    await f.controller.tickIntake();
    expect((await f.thread(item.id)).filter(([m]) => m === "github:120")).toEqual([["github:120", "could this also cover the CLI?"]]);
    expect(await f.githubRows()).toEqual([]);
    expect(await f.store.getWorkItem(item.id)).toMatchObject({ stage: "READY", blocked_reason: "spec_pending", version: item.version });
    expect(await f.store.listStateChanges(item.id)).toHaveLength(changes);
    // A plain comment on a PR's conversation stays unwritten.
    f.hub.comment(9, 121, "nice", { onPr: true });
    await f.controller.tickIntake();
    expect((await f.thread(item.id)).some(([m]) => m === "github:121")).toBe(false);
  });

  it("a GitHub command takes the owner check: a stranger is refused, the owner's linked account acts as the owner; CLI rows never get provider github", async () => {
    const f = await factory();
    const item = await f.specced();
    f.hub.comment(7, 130, "/approve", { user: mallory });
    await f.controller.tickIntake();
    // Refused: mallory is not the owner, and nothing changed.
    expect(await f.store.getWorkItem(item.id)).toMatchObject({ stage: "READY", blocked_reason: "spec_pending" });
    const refusal = (await f.store.listItemMessages(item.id)).find((m) => m.marker === "<!-- factory:refused:130 -->");
    expect(refusal?.body).toContain("`/approve` was not applied");

    f.hub.comment(7, 131, "/approve");
    await f.controller.tickIntake();
    expect(await f.store.getWorkItem(item.id)).toMatchObject({ stage: "RUNNING" });
    expect((await f.store.listStateChanges(item.id)).find((c) => c.reason === "spec_approved")?.actor).toEqual({ kind: "user", id: ME });

    // A row the GitHub source did not write never gets provider github: a GitHub key with a local actor is not
    // applied, and a CLI key with a GitHub actor is judged as provider local.
    const other = await f.specced(8);
    await f.store.appendCliCommand({ key: "github:999", actor: ME, command: "approve", args: { source: other.source, text: "" } });
    await f.controller.tickCommands();
    expect(await f.store.getWorkItem(other.id)).toMatchObject({ stage: "READY", blocked_reason: "spec_pending" });
    const asked = f.local_auth.asked.length;
    await f.store.appendCliCommand({ key: "cli:x", actor: "github:1", command: "approve", args: { item: other.id, source: other.source } });
    await f.controller.tickCommands();
    expect(f.local_auth.asked.slice(asked)).toContain("local:github:1");
  });

  it("a spec written to the thread is mirrored to GitHub once; a second delivery of the same marker posts nothing", async () => {
    const f = await factory();
    const item = await f.specced();
    const spec = (await f.store.listItemMessages(item.id)).find((m) => m.body.includes(triageSpec.done_criteria[0]!))!;
    expect(f.hub.postedOn(7).filter((b) => b.includes(spec.marker))).toHaveLength(1);
    const posts = () => f.hub.calls.filter((c) => c === "POST /repos/o/r/issues/7/comments").length;
    const sent = posts();

    // The same marker again: a repeat thread write, another outbox pass, a second replica, a direct post.
    await f.store.recordItemMessage({ work_item_id: item.id, marker: spec.marker, body: spec.body, delivery: { source_type: "github_issue", target: item.source } });
    await f.controller.tickOutbox();
    const second = await factory({ store: f.store, clock: f.clock });
    await second.controller.tickOutbox();
    expect((await f.source.postComment(item.source, spec.body, spec.marker)).url).toContain("issuecomment-");
    expect(posts()).toBe(sent);
    expect(f.hub.postedOn(7).filter((b) => b.includes(spec.marker))).toHaveLength(1);
    expect((await f.store.getWorkItem(item.id))!.spec_comment_url).toContain("issuecomment-");
  });

  it("a /revise on GitHub shows in the local item thread and is applied like the same CLI command, with the same reply", async () => {
    const f = await factory();
    const gh = await f.specced();
    const created = await f.cli(ME, { action: "create", title: "Add a scope gate", bodyFile: "body.md" });
    const local = created.lines[0] as WorkItemId;
    await f.step();
    expect(await f.store.getWorkItem(local)).toMatchObject({ stage: "READY", blocked_reason: "spec_pending" });
    const refusalOf = async (id: WorkItemId) => (await f.store.listItemMessages(id)).filter((m) => m.marker.startsWith("<!-- factory:refused:")).map((m) => m.body);

    // No feedback: the same refusal, word for word.
    f.hub.comment(7, 140, "/revise");
    await f.controller.tickIntake();
    expect((await f.cli(ME, { action: "command", command: "revise", id: local, text: "" })).code).toBe(0);
    await f.controller.tickCommands();
    expect(await refusalOf(gh.id)).toHaveLength(1);
    expect(await refusalOf(gh.id)).toEqual(await refusalOf(local));

    // With feedback: the same transition and the same run.
    f.hub.comment(7, 141, "/revise keep the existing flag");
    await f.controller.tickIntake();
    expect((await f.cli(ME, { action: "command", command: "revise", id: local, text: "keep the existing flag" })).code).toBe(0);
    await f.controller.tickCommands();
    expect((await f.thread(gh.id)).filter(([m]) => m.startsWith("github:"))).toEqual([
      ["github:140", "/revise"], ["github:141", "/revise keep the existing flag"],
    ]);
    const shape = async (id: WorkItemId) => {
      const it = (await f.store.getWorkItem(id))!;
      const last = (await f.store.listStateChanges(id)).at(-1)!;
      const runs = (await f.store.listRuns(id)).map((r) => [r.kind, r.status]);
      return { stage: it.stage, blocked_on: it.blocked_on, blocked_reason: it.blocked_reason, reason: last.reason, runs };
    };
    expect((await shape(gh.id)).reason).toBe("spec_revision_requested");
    expect(await shape(gh.id)).toEqual(await shape(local));
  });

  it("a command on a PR's conversation carries the PR the poll read, and is applied with no further GitHub read", async () => {
    const f = await factory();
    const { item } = await f.store.createWorkItem(
      { source: issueRef(7), title: "t", requester_id: OWNER, project: config.project.key, problem: "p", resources: [] },
      { kind: "system", id: "system:test" },
    );
    await f.store.transition({
      id: item.id, expected_version: item.version, actor: { kind: "system", id: "system:test" }, reason: "test",
      patch: { stage: "REVIEW", change_ref: "42", blocked_on: "human", blocked_reason: "merge_pending" },
    });
    f.hub.pulls.set(42, { number: 42, head: { ref: `factory/${item.id}` } });
    f.hub.comment(42, 150, "/revise rename the flag", { onPr: true });
    await f.controller.tickIntake();
    expect(await f.githubRows()).toEqual([expect.objectContaining({
      key: "github:150", args: { source: issueRef(42), text: "rename the flag", pr: { change_ref: "42", head_branch: `factory/${item.id}` } },
    })]);
    expect((await f.thread(item.id)).filter(([m]) => m === "github:150")).toEqual([["github:150", "/revise rename the flag"]]);
    expect(await f.store.getWorkItem(item.id)).toMatchObject({ stage: "RUNNING", loop_count: 1 });
    expect(f.hub.calls.filter((c) => c === "GET /repos/o/r/pulls/42")).toHaveLength(1);
  });

  it("a failed GitHub post is retried by the outbox, the item keeps moving, and no marker is posted twice", async () => {
    const f = await factory();
    f.hub.commentError = new Error("GitHub 502");
    f.hub.open.push({ number: 7, title: "Add a scope gate", body: "the body", user: alice, updated_at: "2026-11-07T00:00:00Z" });
    await f.step();
    const item = (await f.store.getWorkItemBySource("github_issue", issueRef(7).id))!;
    expect(item).toMatchObject({ stage: "READY", blocked_reason: "spec_pending" });
    expect(f.hub.postedOn(7)).toEqual([]);
    expect((await f.store.listDeliveries(item.id)).every((d) => d.delivered_at === null && d.attempts >= 1)).toBe(true);

    // The item moves on while the spec is still undelivered.
    f.hub.comment(7, 160, "/approve");
    await f.controller.tickIntake();
    expect(await f.store.getWorkItem(item.id)).toMatchObject({ stage: "RUNNING" });

    f.hub.commentError = null;
    for (let i = 0; i < 6; i++) {
      f.clock.advance(config.retry_max_ms);
      await f.controller.tickOutbox();
    }
    const deliveries = await f.store.listDeliveries(item.id);
    expect(deliveries.length).toBeGreaterThan(0);
    expect(deliveries.every((d) => d.delivered_at !== null)).toBe(true);
    const markers = deliveries.map((d) => d.marker);
    for (const m of markers) expect(f.hub.postedOn(7).filter((b) => b.includes(m))).toHaveLength(1);
  });

  it("upgrade: started with a cursor the old code wrote, the controller applies no GitHub command at or below its last_comment_id", async () => {
    const f = await factory();
    const item = await f.specced();
    const old = JSON.parse((await f.store.getCursor("intake:github_issue"))!) as Record<string, unknown>;
    // The old code's cursor: comments read up to id 170 (its /approve was applied then, as an event).
    const cursor = JSON.stringify({ ...old, last_comment_id: 170 });
    expect(await f.store.advanceCursor("intake:github_issue", JSON.stringify(old), cursor)).toBe(true);
    f.hub.comment(7, 169, "/approve");
    f.hub.comment(7, 170, "/reject not now");
    f.hub.comment(7, 171, "/help");
    const fresh = await factory({ store: f.store, clock: f.clock });
    fresh.hub.polled = f.hub.polled;
    await fresh.controller.tickIntake();
    expect((await fresh.githubRows()).map((r) => r.key)).toEqual(["github:171"]);
    expect(await f.store.getWorkItem(item.id)).toMatchObject({ stage: "READY", blocked_reason: "spec_pending" });
    // The cursor keeps its format: the same fields, the comment-id mark moved on.
    const next = JSON.parse((await f.store.getCursor("intake:github_issue"))!) as Record<string, unknown>;
    expect(Object.keys(next).sort()).toEqual(Object.keys(old).sort());
    expect(next.last_comment_id).toBe(171);
  });

  it("with no github-issues source, a GitHub row in the inbox is passed and no GitHub code runs", async () => {
    const f = await factory();
    const item = await f.specced();
    const log = recordingLog();
    const localOnly = new ControllerRole({
      store: f.store, sources: [new LocalSource(f.store)], auth: new GitHubAuthProvider(f.store, []), clock: f.clock, config, log,
      scanner: cleanScanner, repeated_failure_rule: false,
    });
    await f.store.appendCliCommand({ key: "github:180", actor: "github:1", command: "approve", args: { source: item.source, text: "" } });
    const calls = f.hub.calls.length;
    await localOnly.tickCommands();
    expect(await f.store.getWorkItem(item.id)).toMatchObject({ stage: "READY", blocked_reason: "spec_pending" });
    expect(f.hub.calls).toHaveLength(calls);
    expect(log.lines.filter((l) => l.level === "error")).toEqual([]);
  });
});

describe("CLI commands on a GitHub item (design 05-sources, CLI intake)", () => {
  const OUTAGE = new Error("GitHub unreachable");
  const RATE_LIMITED = new GitHubError(403, "API rate limit exceeded", "2026-11-07T02:00:00Z");
  const approve = (id: WorkItemId, text = ""): CliAction => ({ action: "command", command: "approve", id, text });
  const mirrors = (f: Awaited<ReturnType<typeof factory>>, n = 7) => f.hub.postedOn(n).filter((b) => b.includes("<!-- factory:cli:cli:"));
  const refusal = async (f: Awaited<ReturnType<typeof factory>>, id: WorkItemId) =>
    (await f.store.listItemMessages(id)).find((m) => m.marker.startsWith("<!-- factory:refused:cli:"))?.body;

  it("is stored and exits 0 with GitHub unreachable: the CLI makes no GitHub call", async () => {
    const f = await factory();
    const item = await f.specced();
    f.hub.down = OUTAGE;
    const calls = f.hub.calls.length;
    const r = await f.cli(ME, approve(item.id, "ship it"));
    expect(r.code).toBe(0);
    expect(r.lines[0]).toContain(`stored \`/approve\` for ${item.id} as ${ME}`);
    expect(f.hub.calls).toHaveLength(calls);
    expect(await f.store.listUnmirroredCliCommands(10)).toEqual([
      expect.objectContaining({ actor: ME, command: "approve", args: { item: item.id, text: "ship it" }, mirror: true }),
    ]);
  });

  it("solo: the environment user becomes the owner on the first command and approves through the same transition a GitHub comment gives, while every GitHub call fails", async () => {
    const f = await factory();
    const byComment = await f.specced(7);
    const byCli = await f.specced(8);
    f.hub.comment(7, 140, "/approve");
    await f.controller.tickIntake();

    f.hub.down = OUTAGE;
    expect((await f.cli(ME, approve(byCli.id))).code).toBe(0);
    expect(await f.store.listLocalUsers()).toEqual([expect.objectContaining({ user_id: ME, role: "owner" })]);
    await f.controller.tickCommands();

    const state = (it: WorkItem | null) => ({ stage: it!.stage, blocked_on: it!.blocked_on, blocked_reason: it!.blocked_reason });
    expect(state(await f.store.getWorkItem(byCli.id))).toEqual(state(await f.store.getWorkItem(byComment.id)));
    expect(await f.store.getWorkItem(byCli.id)).toMatchObject({ stage: "RUNNING" });
    const approval = (await f.store.listStateChanges(byCli.id)).find((c) => c.reason === "spec_approved");
    expect(approval?.actor).toEqual({ kind: "user", id: ME });
    // The local auth plugin judged it; the GitHub calls it made on the way (labels, the mirror) all failed.
    expect(f.local_auth.asked).toContain(`local:${ME.slice("local:".length)}`);
    expect(f.hub.calls.filter((c) => c.startsWith("FAILED")).length).toBeGreaterThan(0);
    // The mirror's failure is logged, and it waits: the item moved on.
    expect(f.log.lines.some((l) => l.level === "warn" && l.msg === "outbox delivery failed; retried later")).toBe(true);
    expect((await f.store.listUnmirroredCliCommands(10)).map((c) => c.args.item)).toEqual([byCli.id]);
  });

  it("only the owner is allowed: an approver, a requester or anonymous is refused with the owner reply, and nothing changes", async () => {
    const f = await factory();
    const items = [await f.specced(7), await f.specced(8), await f.specced(9), await f.specced(10)];
    f.hub.down = OUTAGE;
    expect((await f.cli(ME, { action: "users_add", user: "local:bob" as UserId, role: "approver" })).code).toBe(0);
    expect((await f.cli(ME, { action: "users_add", user: "local:carol" as UserId, role: "requester" })).code).toBe(0);
    await f.cli(ME, approve(items[0]!.id));
    await f.cli("local:bob" as UserId, approve(items[1]!.id));
    await f.cli("local:carol" as UserId, approve(items[2]!.id));
    await f.cli("local:anonymous" as UserId, approve(items[3]!.id));
    await f.controller.tickCommands();

    expect(await f.store.getWorkItem(items[0]!.id)).toMatchObject({ stage: "RUNNING" });
    for (const it of items.slice(1)) {
      expect(await f.store.getWorkItem(it.id)).toMatchObject({ stage: "READY", blocked_reason: "spec_pending", version: it.version });
      expect(await refusal(f, it.id)).toBe("`/approve` was not applied: only the owner may send this command.");
    }
    expect(f.local_auth.asked).toEqual(expect.arrayContaining(["local:bob", "local:carol", "local:anonymous"]));
  });

  it("mirrors each command once on its issue, keyed by the command key; another mirror pass or replica posts nothing new", async () => {
    const f = await factory();
    const item = await f.specced();
    await f.cli(ME, { action: "command", command: "revise", id: item.id, text: "split the parser\n/retry is not a command here" });
    const [cmd] = await f.store.listUnmirroredCliCommands(10);
    await f.controller.tickCommands();
    await f.controller.tickCommands();

    expect(mirrors(f)).toEqual([
      `\`/revise\` was sent from the factory CLI by \`${ME}\` (command \`${cmd!.key}\`).\n\n> split the parser\n> /retry is not a command here\n\n<!-- factory:cli:${cmd!.key} -->`,
    ]);
    expect(await f.store.listUnmirroredCliCommands(10)).toEqual([]);
    const posts = f.hub.calls.filter((c) => c === "POST /repos/o/r/issues/7/comments").length;
    await f.controller.tickCommands();
    await (await factory({ store: f.store, clock: f.clock })).controller.tickCommands();
    expect(f.hub.calls.filter((c) => c === "POST /repos/o/r/issues/7/comments")).toHaveLength(posts);
    expect(mirrors(f)).toHaveLength(1);
  });

  it("the mirror never starts with `/`, so the GitHub poll reads it as a plain comment", async () => {
    const f = await factory();
    const item = await f.specced();
    await f.cli(ME, { action: "command", command: "retry", id: item.id, text: "" });
    await f.cli(ME, { action: "command", command: "reject", id: item.id, text: "/approve" });
    await f.controller.tickCommands();
    await f.controller.tickCommands();
    const posted = mirrors(f);
    expect(posted).toHaveLength(2);
    for (const body of posted) {
      expect(body.startsWith("/")).toBe(false);
      expect(parseComment(body)).toBeNull();
    }
  });

  for (const [what, failure] of [["fails", OUTAGE], ["is rate limited", RATE_LIMITED]] as const) {
    it(`when the post ${what}, the command stays unmirrored, and a later tick posts it once GitHub works`, async () => {
      const f = await factory();
      const item = await f.specced();
      await f.cli(ME, approve(item.id));
      f.hub.down = failure;
      await f.controller.tickCommands();
      await f.controller.tickCommands();
      expect(await f.store.getWorkItem(item.id)).toMatchObject({ stage: "RUNNING" });
      expect((await f.store.listUnmirroredCliCommands(10)).map((c) => c.args.item)).toEqual([item.id]);
      expect(mirrors(f)).toEqual([]);

      f.hub.down = null;
      f.clock.advance(3 * 3_600_000);
      await f.controller.tickCommands();
      await f.controller.tickCommands();
      expect(mirrors(f)).toHaveLength(1);
      expect(await f.store.listUnmirroredCliCommands(10)).toEqual([]);
    });
  }
});
