import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { uiCommandsActor } from "../src/compose.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { OwnerAuth } from "../src/core/authorize.js";
import type { SourceRef, UserId, WorkItem, WorkItemPatch } from "../src/core/types.js";
import { parseVerdict } from "../src/core/verdict.js";
// TS6142: tsconfig.test.json has no JSX, so this .tsx view stays untyped here; web/tsconfig.json checks it.
// @ts-expect-error -- see above
import { oneTapNote, verdictNote } from "../web/src/views/item-commands.js";
import type { AppCommandRequest } from "../src/interfaces/factory-store.js";
import type { LLMProvider, LLMRequest, LLMResponse } from "../src/interfaces/llm-provider.js";
import { parseProposalMarker } from "../src/core/interpret.js";
import type { PageAction } from "../src/ui/commands.js";
import { HealthMonitor } from "../src/ui/health.js";
import { type ApiDeps, type UiDeps, respond } from "../src/ui/server.js";
import { refusalText } from "../src/core/commands.js";
import { runLocalCli } from "../src/core/local-cli.js";
import { newCsrfToken } from "../src/ui/settings-api.js";
import { FakeAuth, FakeSource, alice, cleanScanner, config, issueRef, silent, waitFor } from "./helpers/fakes.js";
import { PROJECT_KEY, newStore } from "./helpers/store.js";
import { classifierAnswer } from "./helpers/classifier.js";

// App command requests (issues #245, #282): a request row in the store is a new entry point to the comment command
// path. It lands in the command inbox too; each controller tick reads the inbox and applies `approve` with the same permission check and
// transition as a `/approve` comment; `reject`, `verdict` and `merge` are in tests/app-reject-verdict.test.ts and tests/app-merge.test.ts;
// anything else is refused with one reply, keyed on the request.

/** FakeAuth lets github:1 (alice) approve, nobody else. */
const WRITER = "github:1" as UserId;
const READER = "github:666" as UserId;
const SPEC_PENDING: WorkItemPatch = { stage: "READY", blocked_on: "human", blocked_reason: "spec_pending" };
const IMPLEMENTING: WorkItemPatch = { stage: "RUNNING" };

/** Past the first retry of a failed command on controller.commands. */
const RETRY_MS = 1_000;

async function harness(opts: { localAuth?: boolean; tick_ms?: number } = {}) {
  const { store, clock } = await newStore();
  const source = new FakeSource();
  const auth = opts.localAuth ? new OwnerAuth(store) : new FakeAuth();
  const controller = new ControllerRole({ store, source, auth, clock, config: { ...config, tick_ms: opts.tick_ms ?? config.tick_ms }, log: silent, scanner: cleanScanner });
  const actor = { kind: "system" as const, id: "system:test" };
  /** A work item on issue `n`, put in the state `patch` describes. */
  const itemIn = async (patch: WorkItemPatch, n: number): Promise<WorkItem> => {
    const { item } = await store.createWorkItem(
      { source: issueRef(n), requester_id: WRITER, project: PROJECT_KEY, problem: "p", resources: [] },
      actor,
    );
    const r = await store.transition({ id: item.id, expected_version: item.version, actor, reason: "setup", patch: { ...patch, tier: 2 } });
    if (!r.ok) throw new Error("setup failed");
    return r.item;
  };
  const request = async (key: string, actorId: UserId, command: string, args: Record<string, unknown>): Promise<AppCommandRequest> =>
    (await store.recordAppCommandRequest({ key, actor: actorId, command, args })).request;
  const marker = (r: AppCommandRequest) => `<!-- factory:refused:app-${r.seq} -->`;
  /** The seqs of `rs` not yet handled, in the order given. */
  const pending = async (...rs: AppCommandRequest[]): Promise<number[]> => {
    const out: number[] = [];
    for (const r of rs) if ((await store.getAppCommandRequest(r.seq))!.handled_at === null) out.push(r.seq);
    return out;
  };
  /** What an item's history and runs look like, minus ids and times. */
  const shape = async (it: WorkItem) => ({
    item: await store.getWorkItem(it.id).then((x) => ({ stage: x!.stage, blocked_on: x!.blocked_on, blocked_reason: x!.blocked_reason })),
    changes: (await store.listStateChanges(it.id)).slice(2).map((c) => ({ reason: c.reason, actor: c.actor, changes: c.changes })),
    runs: (await store.listRuns(it.id)).map((r) => ({ kind: r.kind, status: r.status })),
  });
  return { store, clock, source, controller, itemIn, request, marker, pending, shape };
}

describe("app command requests: approve", () => {
  it("an approve request on a spec waiting for approval queues one implement run, the same change a /approve comment makes", async () => {
    const h = await harness();
    const byApp = await h.itemIn(SPEC_PENDING, 1);
    const byComment = await h.itemIn(SPEC_PENDING, 2);
    const r = await h.request("k1", WRITER, "approve", { work_item_id: byApp.id });

    await h.controller.tickCommands();
    await h.controller.handleEvent({ kind: "spec_approved", source: issueRef(2), comment_id: "c2", approver: alice });

    const app = await h.shape(byApp);
    expect(app).toEqual(await h.shape(byComment));
    expect(app.item).toEqual({ stage: "RUNNING", blocked_on: "none", blocked_reason: null });
    expect(app.changes).toEqual([
      expect.objectContaining({ reason: "spec_approved", actor: { kind: "user", id: WRITER } }),
    ]);
    expect(app.runs).toEqual([{ kind: "implement", status: "queued" }]);
    // The run key is the one the comment path uses for the item.
    const [appRun] = await h.store.listRuns(byApp.id);
    expect(appRun!.idempotency_key).toContain(byApp.id);
    expect(await h.store.getAppCommandRequest(r.seq)).toMatchObject({ handled_at: h.clock.now().toISOString(), refusal: null });
    expect(h.source.comments.filter((c) => c.marker === h.marker(r))).toEqual([]);
  });

  it("an approve note is stored on the state change, as a /approve note is", async () => {
    const h = await harness();
    const it1 = await h.itemIn(SPEC_PENDING, 1);
    await h.request("k1", WRITER, "approve", { work_item_id: it1.id, note: "  keep it small  " });
    await h.controller.tickCommands();
    const approval = (await h.store.listStateChanges(it1.id)).find((c) => c.reason === "spec_approved");
    expect(approval?.detail).toMatchObject({ note: "keep it small" });
  });

  it("applying the same request twice leaves one state change and one run", async () => {
    const h = await harness();
    const it1 = await h.itemIn(SPEC_PENDING, 1);
    const r = await h.request("k1", WRITER, "approve", { work_item_id: it1.id });
    await h.controller.tickCommands();
    await h.controller.tickCommands();
    // The same key recorded again is the same request.
    await h.request("k1", WRITER, "approve", { work_item_id: it1.id });
    await h.controller.tickCommands();
    const s = await h.shape(it1);
    expect(s.changes.map((c) => c.reason)).toEqual(["spec_approved"]);
    expect(s.runs).toHaveLength(1);
    expect(h.source.comments).toEqual([]);
    expect((await h.store.getAppCommandRequest(r.seq))!.refusal).toBeNull();
  });

  it("applied but not marked (a crash, another replica): the next tick marks it applied, with no second change and no refusal", async () => {
    const h = await harness();
    const it1 = await h.itemIn(SPEC_PENDING, 1);
    const r = await h.request("k1", WRITER, "approve", { work_item_id: it1.id });
    const mark = h.store.markAppCommandRequest.bind(h.store);
    let fail = true;
    h.store.markAppCommandRequest = async (seq, refusal) => {
      if (fail) {
        fail = false;
        throw new Error("lost");
      }
      return mark(seq, refusal);
    };
    await h.controller.tickCommands();
    expect(await h.pending(r)).toEqual([r.seq]);
    // The bus retries a failed command after its topic's backoff (RFC 0015 M4), the first time after a second.
    h.clock.advance(RETRY_MS);
    await h.controller.tickCommands();

    const s = await h.shape(it1);
    expect(s.changes.map((c) => c.reason)).toEqual(["spec_approved"]);
    expect(s.runs).toHaveLength(1);
    expect(h.source.comments).toEqual([]);
    expect(await h.store.getAppCommandRequest(r.seq)).toMatchObject({ refusal: null });
    expect(await h.pending(r)).toEqual([]);
  });

  it("approve on an item not waiting for approval gets the same refusal text the /approve comment gets", async () => {
    const h = await harness();
    const byApp = await h.itemIn(IMPLEMENTING, 1);
    const byComment = await h.itemIn(IMPLEMENTING, 2);
    const r = await h.request("k1", WRITER, "approve", { work_item_id: byApp.id });
    await h.controller.tickCommands();
    await h.controller.handleEvent({ kind: "spec_approved", source: issueRef(2), comment_id: "c2", approver: alice });

    const fromApp = h.source.comments.filter((c) => c.marker === h.marker(r));
    const fromComment = h.source.comments.filter((c) => c.marker === "<!-- factory:refused:c2 -->");
    expect(fromApp).toHaveLength(1);
    expect(fromComment).toHaveLength(1);
    expect(fromApp[0]!.body).toBe(fromComment[0]!.body);
    expect(fromApp[0]!.source).toEqual(byApp.source);
    expect(fromApp[0]!.body).toMatch(/^`\/approve` was not applied: the spec is not waiting for approval/);
    expect((await h.store.getAppCommandRequest(r.seq))!.refusal).toBe(fromApp[0]!.body);
    expect(await h.store.getWorkItem(byApp.id)).toEqual(byApp);
  });
});

describe("app command requests: refusals", () => {
  it("a user without approve_spec is refused: item and runs unchanged, the refusal stored on the row and posted once", async () => {
    const h = await harness();
    const it1 = await h.itemIn(SPEC_PENDING, 1);
    const runsBefore = await h.store.listRuns(it1.id);
    const r = await h.request("k1", READER, "approve", { work_item_id: it1.id });
    await h.controller.tickCommands();
    await h.controller.tickCommands();

    expect(await h.store.getWorkItem(it1.id)).toEqual(it1);
    expect(await h.store.listRuns(it1.id)).toEqual(runsBefore);
    const posted = h.source.comments.filter((c) => c.marker === h.marker(r));
    expect(posted).toHaveLength(1);
    expect(posted[0]!.source).toEqual(it1.source);
    expect(posted[0]!.body).toBe("`/approve` was not applied: only the owner may send this command (`not_a_collaborator`).");
    expect(await h.store.getAppCommandRequest(r.seq)).toMatchObject({ handled_at: h.clock.now().toISOString(), refusal: posted[0]!.body });
  });

  it("a command that is not applied from an app request gets one refusal reply and no state change", async () => {
    const h = await harness();
    const it1 = await h.itemIn(SPEC_PENDING, 1);
    const r = await h.request("k1", WRITER, "budget", { work_item_id: it1.id, note: "1000" });
    await h.controller.tickCommands();
    await h.controller.tickCommands();

    expect(await h.store.getWorkItem(it1.id)).toEqual(it1);
    expect(await h.store.listRuns(it1.id)).toEqual([]);
    const posted = h.source.comments.filter((c) => c.marker === h.marker(r));
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body).toBe("`budget` was not applied: only `approve`, `merge`, `reject`, `resolve`, `retry`, `revise` and `verdict` are applied from an app request; reply `/budget` on the issue instead.");
    expect((await h.store.getAppCommandRequest(r.seq))!.refusal).toBe(posted[0]!.body);
    expect(h.source.comments).toHaveLength(1);
  });

  it("an odd command name is not echoed into the reply", async () => {
    const h = await harness();
    const it1 = await h.itemIn(SPEC_PENDING, 1);
    const r = await h.request("k1", WRITER, "@everyone <b>", { work_item_id: it1.id });
    await h.controller.tickCommands();
    const posted = h.source.comments.filter((c) => c.marker === h.marker(r));
    expect(posted.map((c) => c.body)).toEqual(["The command was not applied: only `approve`, `merge`, `reject`, `resolve`, `retry`, `revise` and `verdict` are applied from an app request."]);
  });

  it("a request for no known work item is refused on its row only: nothing is posted", async () => {
    const h = await harness();
    const missing = await h.request("k1", WRITER, "approve", { work_item_id: "wi_nope" });
    const none = await h.request("k2", WRITER, "approve", {});
    await h.controller.tickCommands();
    expect((await h.store.getAppCommandRequest(missing.seq))!.refusal).toBe("`/approve` was not applied: the work item was not found.");
    expect((await h.store.getAppCommandRequest(none.seq))!.refusal).toBe("`/approve` was not applied: the request names no work item.");
    expect(h.source.comments).toEqual([]);
    expect(await h.pending(missing, none)).toEqual([]);
  });

  it("a refusal is written to the thread and stored on the row at once; a failed post is retried by the outbox, once", async () => {
    const h = await harness();
    const it1 = await h.itemIn(SPEC_PENDING, 1);
    const r = await h.request("k1", READER, "approve", { work_item_id: it1.id });
    const real = h.source.postComment.bind(h.source);
    let fail = true;
    h.source.postComment = async (...args) => {
      if (fail) {
        fail = false;
        throw new Error("forge down");
      }
      return real(...args);
    };
    await h.controller.tickCommands();
    expect((await h.store.getAppCommandRequest(r.seq))!.refusal).toMatch(/^`\/approve` was not applied: only the owner may send this command/);
    expect((await h.store.listItemMessages(it1.id)).map((m) => m.marker)).toContain(h.marker(r));
    expect(h.source.comments).toEqual([]);
    h.clock.advance(config.retry_max_ms);
    await h.controller.tickCommands();
    await h.controller.tickCommands();
    expect(h.source.comments.filter((c) => c.marker === h.marker(r))).toHaveLength(1);
  });

  it("requests are applied oldest first; a failing request holds the ones after it until the next tick", async () => {
    const h = await harness();
    const a = await h.itemIn(SPEC_PENDING, 1);
    const b = await h.itemIn(SPEC_PENDING, 2);
    const ra = await h.request("ka", WRITER, "approve", { work_item_id: a.id });
    const rb = await h.request("kb", WRITER, "approve", { work_item_id: b.id });
    const get = h.store.getWorkItem.bind(h.store);
    h.store.getWorkItem = async (id) => {
      if (id === a.id) throw new Error("boom");
      return get(id);
    };
    await h.controller.tickCommands();
    expect(await h.pending(ra, rb)).toEqual([ra.seq, rb.seq]);
    h.store.getWorkItem = get;
    h.clock.advance(RETRY_MS);
    await h.controller.tickCommands();
    expect((await h.store.getWorkItem(a.id))!.stage).toBe("RUNNING");
    expect((await h.store.getWorkItem(b.id))!.stage).toBe("RUNNING");
    expect(await h.pending(ra, rb)).toEqual([]);
  });
});

describe("app command requests: the controller loop", () => {
  it("each tick reads pending requests, without waiting for the poll interval", async () => {
    // Inbound's intake tick runs on its TickGenerator (RFC 0015 M4), in real time: a short tick keeps the test short.
    const tick_ms = 20;
    const h = await harness({ tick_ms });
    const it1 = await h.itemIn(SPEC_PENDING, 1);
    const ac = new AbortController();
    const running = h.controller.run(ac.signal);
    // The first tick polls; record the request only after it, so the next poll is poll_interval_ms away.
    await waitFor(() => h.source.polls.length > 0, "first poll");
    const polls = h.source.polls.length;
    const r = await h.request("k1", WRITER, "approve", { work_item_id: it1.id });
    await waitFor(async () => (await h.store.getAppCommandRequest(r.seq))!.handled_at !== null, "handled");
    ac.abort();
    await running;
    expect(tick_ms * 20).toBeLessThan(config.poll_interval_ms);
    expect(h.source.polls.length).toBe(polls);
    expect((await h.store.getAppCommandRequest(r.seq))!.handled_at).not.toBeNull();
    expect((await h.store.getWorkItem(it1.id))!.stage).toBe("RUNNING");
  });
});

describe("app command requests: from the page's POST (issue #227)", () => {
  const HOST = "127.0.0.1:4310";
  const TOKEN = newCsrfToken();

  function page(h: Awaited<ReturnType<typeof harness>>, actor: UserId, source: "config" | "environment" = "config"): UiDeps {
    return {
      store: h.store, scanner: cleanScanner, clock: h.clock, lease_ms: 60_000,
      health: new HealthMonitor(async () => [], h.clock), commands: { actor, source, token: TOKEN },
    };
  }

  const post = (d: UiDeps, it: WorkItem, body: unknown) =>
    respond(d, {
      method: "POST", url: `/api/v1/items/${encodeURIComponent(it.id)}/commands`, host: HOST, origin: `http://${HOST}`,
      contentType: "application/json", csrfToken: TOKEN, body: JSON.stringify(body),
    });

  it("an approve POST becomes the controller's approve, with ui.user_id's permissions and the note", async () => {
    const h = await harness();
    const it1 = await h.itemIn(SPEC_PENDING, 1);
    expect((await post(page(h, WRITER), it1, { command: "approve", note: "keep it small" })).status).toBe(202);
    await h.controller.tickCommands();
    const s = await h.shape(it1);
    expect(s.item).toEqual({ stage: "RUNNING", blocked_on: "none", blocked_reason: null });
    expect(s.changes).toEqual([expect.objectContaining({ reason: "spec_approved", actor: { kind: "user", id: WRITER } })]);
    const approval = (await h.store.listStateChanges(it1.id)).find((c) => c.reason === "spec_approved");
    expect(approval?.detail).toMatchObject({ note: "keep it small" });
  });

  it("a POST by a user without the permission, or of a command the state cannot take, is refused by the controller and shown in replies", async () => {
    const h = await harness();
    const it1 = await h.itemIn(SPEC_PENDING, 1);
    expect((await post(page(h, READER), it1, { command: "approve" })).status).toBe(202);
    expect((await post(page(h, WRITER), it1, { command: "retry", note: "no" })).status).toBe(202);
    await h.controller.tickCommands();
    expect((await h.store.getWorkItem(it1.id))!.blocked_reason).toBe("spec_pending");
    const r = await respond(page(h, WRITER), { method: "GET", url: `/api/v1/items/${encodeURIComponent(it1.id)}`, host: HOST });
    const replies = (JSON.parse(r.body) as { replies: { command: string; refusal: string | null; handled_at: string | null }[] }).replies;
    expect(replies.map((x) => x.command)).toEqual(["approve", "retry"]);
    expect(replies[0]!.refusal).toMatch(/^`\/approve` was not applied: only the owner may send this command/);
    expect(replies[1]!.refusal).toBe("`/retry` was not applied: there is no failed run to retry.");
    for (const x of replies) expect(x.handled_at).not.toBeNull();
  });

  it("without ui.user_id, a loopback page acts as the CLI identity: the owner's approve applies, another local user's is refused", async () => {
    const h = await harness({ localAuth: true });
    const owner = "local:owner@example.com" as UserId;
    const helper = "local:helper@example.com" as UserId;
    const env = (user: UserId) => uiCommandsActor(null, { user, from: "git user.email" }, "127.0.0.1");
    expect(env(owner)).toEqual({ actor: owner, source: "environment" });
    await h.store.claimOwner(owner);

    const it1 = await h.itemIn(SPEC_PENDING, 1);
    expect((await post(page(h, env(helper).actor!, "environment"), it1, { command: "approve" })).status).toBe(202);
    await h.controller.tickCommands();
    expect((await h.store.getWorkItem(it1.id))!.blocked_reason).toBe("spec_pending");
    const [refused] = await h.store.listAppCommandRequestsForItem(it1.id, 10);
    expect(refused!.refusal).toMatch(/^`\/approve` was not applied/);

    expect((await post(page(h, env(owner).actor!, "environment"), it1, { command: "approve" })).status).toBe(202);
    await h.controller.tickCommands();
    const s = await h.shape(it1);
    expect(s.item).toEqual({ stage: "RUNNING", blocked_on: "none", blocked_reason: null });
    expect(s.changes).toEqual([expect.objectContaining({ reason: "spec_approved", actor: { kind: "user", id: owner } })]);
  });
});

describe("the page's commands actor (uiCommandsActor, design 09)", () => {
  const env = { user: "local:me@example.com" as UserId, from: "git user.email" as const };
  const TOKEN = newCsrfToken();

  it("ui.user_id overrides the environment, on any bind address", () => {
    for (const bind of ["127.0.0.1", "0.0.0.0"]) expect(uiCommandsActor("github:7" as UserId, env, bind)).toEqual({ actor: "github:7", source: "config" });
  });

  it("on loopback without ui.user_id it is the CLI identity; cli_user counts as config", () => {
    for (const bind of ["127.0.0.1", "::1", "localhost"]) expect(uiCommandsActor(null, env, bind)).toEqual({ actor: env.user, source: "environment" });
    expect(uiCommandsActor(null, { user: "github:9" as UserId, from: "cli_user" }, "127.0.0.1")).toEqual({ actor: "github:9", source: "config" });
  });

  it("a non-loopback server without ui.user_id has no actor, and a POST is the 503 naming ui.user_id", async () => {
    const off = uiCommandsActor(null, env, "0.0.0.0");
    expect(off).toEqual({ actor: null, source: null });
    const h = await harness();
    const it1 = await h.itemIn(SPEC_PENDING, 1);
    const d: UiDeps = {
      store: h.store, scanner: cleanScanner, clock: h.clock, lease_ms: 60_000,
      health: new HealthMonitor(async () => [], h.clock), commands: { ...off, token: TOKEN },
    };
    const r = await respond(d, {
      method: "POST", url: `/api/v1/items/${encodeURIComponent(it1.id)}/commands`, host: "127.0.0.1:4310", origin: "http://127.0.0.1:4310",
      contentType: "application/json", csrfToken: TOKEN, body: JSON.stringify({ command: "approve" }),
    });
    expect(r.status).toBe(503);
    expect(JSON.parse(r.body).error).toBe("Commands are off: this server is not on loopback, so it needs ui.user_id. Settings (/app/settings#page-commands) says what to set.");
    expect(await h.store.listAppCommandRequestsForItem(it1.id, 10)).toEqual([]);
  });
});

describe("the item API's commands: by phase and by the viewer's grants (issue #528)", () => {
  const HOST = "127.0.0.1:4310";
  const TOKEN = newCsrfToken();
  type Listed = { commands: { name: string; allowed: boolean; reason: string | null }[] };

  /** The page as `actor`, its grants checked as compose.ts checks them: the local auth plugin over the local grants, on the project. */
  function page(h: Awaited<ReturnType<typeof harness>>, actor: UserId): ApiDeps {
    const auth = new OwnerAuth(h.store);
    const allowed = (action: PageAction) => auth.authorize({ user_id: actor, attributes: {} }, action, { kind: "project", id: PROJECT_KEY });
    return {
      store: h.store, scanner: cleanScanner, clock: h.clock, lease_ms: 60_000,
      health: new HealthMonitor(async () => [], h.clock), commands: { actor, source: "environment", token: TOKEN, allowed },
    };
  }
  const listed = async (d: ApiDeps, it: WorkItem): Promise<Listed> =>
    JSON.parse((await respond(d, { method: "GET", url: `/api/v1/items/${encodeURIComponent(it.id)}`, host: HOST })).body) as Listed;
  const names = (l: Listed) => l.commands.map((c) => c.name);

  const STAGES: [string, WorkItemPatch, string[]][] = [
    ["NEW (triaging)", {}, ["reject"]],
    ["READY at the spec gate", SPEC_PENDING, ["approve", "reject", "revise"]],
    ["READY at the revision limit", { stage: "READY", blocked_on: "human", blocked_reason: "max_revisions" }, ["approve", "reject"]],
    ["RUNNING (implementing)", IMPLEMENTING, ["reject"]],
    ["RUNNING after a failed implement run", { stage: "RUNNING", blocked_on: "human", blocked_reason: "run_failed:implement:agent_error" }, ["reject", "revise", "retry"]],
    ["REVIEW (reviewing)", { stage: "REVIEW", change_ref: "42" }, ["reject", "verdict"]],
    ["REVIEW waiting for a merge", { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", change_ref: "42" }, ["reject", "verdict"]],
    ["CLOSED, merged", { stage: "CLOSED", close_reason: "completed", change_ref: "42", merge_sha: "abc" }, ["verdict"]],
    ["CLOSED without a merge", { stage: "CLOSED", close_reason: "rejected" }, []],
  ];

  it("each stage lists only the commands that apply in it, each allowed for the owner", async () => {
    const h = await harness({ localAuth: true });
    const owner = "local:owner@example.com" as UserId;
    await h.store.claimOwner(owner);
    let n = 0;
    for (const [stage, patch, want] of STAGES) {
      const l = await listed(page(h, owner), await h.itemIn(patch, ++n));
      expect({ stage, names: names(l) }).toEqual({ stage, names: want });
      for (const c of l.commands) expect(c, stage).toMatchObject({ allowed: true, reason: null });
    }
  });

  it("a non-owner sees approve, reject and revise disallowed; the reason is the refusal the controller gives the same command", async () => {
    const h = await harness({ localAuth: true });
    const owner = "local:owner@example.com" as UserId;
    const helper = "local:helper@example.com" as UserId;
    await h.store.claimOwner(owner);
    const it1 = await h.itemIn(SPEC_PENDING, 1);
    const l = await listed(page(h, helper), it1);
    expect(l.commands.map((c) => [c.name, c.allowed, c.reason])).toEqual(
      ["approve", "reject", "revise"].map((n) => [n, false, "only the owner may send this command"]),
    );
    // Sent anyway (another page, the CLI): the controller, with the owner check as compose.ts wires it, refuses it
    // with the same reason.
    const local = new OwnerAuth(h.store);
    const controller = new ControllerRole({ store: h.store, source: h.source, auth: local, clock: h.clock, config, log: silent, scanner: cleanScanner });
    await h.request("app-x", helper, "approve", { work_item_id: it1.id });
    await controller.tickCommands();
    const [row] = await h.store.listAppCommandRequestsForItem(it1.id, 10);
    expect(row!.refusal).toBe(refusalText("/approve", l.commands[0]!.reason!));
    // A closed stage with nothing to send lists nothing.
    expect((await listed(page(h, helper), await h.itemIn({ stage: "CLOSED", close_reason: "rejected" }, 2))).commands).toEqual([]);
  });

  it("solo: with no link and no owner yet, the dashboard and the CLI both offer and take approve", async () => {
    const h = await harness({ localAuth: true });
    const me = "local:me@example.com" as UserId;
    expect(await h.store.getOwner()).toBeNull();
    const byPage = await h.itemIn(SPEC_PENDING, 1);
    const byCli = await h.itemIn(SPEC_PENDING, 2);
    expect(names(await listed(page(h, me), byPage))).toEqual(["approve", "reject", "revise"]);
    await h.request("app-solo", me, "approve", { work_item_id: byPage.id });
    const cli = { store: h.store, identity: { user: me, from: "git user.email" as const }, project: async () => PROJECT_KEY, read: async () => "", newId: () => "solo" };
    expect((await runLocalCli(cli, { action: "command", command: "approve", id: byCli.id, text: "" })).code).toBe(0);
    await h.controller.tickCommands();
    for (const it of [byPage, byCli]) expect((await h.store.getWorkItem(it.id))!.stage).toBe("RUNNING");
  });

  it("an item that left the spec gate lists no approve or revise, only reject: the actions follow the item's state now (issue #586)", async () => {
    const h = await harness({ localAuth: true });
    const me = "local:me@example.com" as UserId;
    const it1 = await h.itemIn(SPEC_PENDING, 1);
    expect(names(await listed(page(h, me), it1))).toEqual(["approve", "reject", "revise"]);
    await h.request("app-586", me, "approve", { work_item_id: it1.id });
    await h.controller.tickCommands();
    expect((await h.store.getWorkItem(it1.id))!.stage).toBe("RUNNING");
    expect(names(await listed(page(h, me), it1))).toEqual(["reject"]);
  });
});

describe("verdict from the item page and the item API (issue #523)", () => {
  const HOST = "127.0.0.1:4310";
  const TOKEN = newCsrfToken();
  const ME = "local:me@example.com" as UserId;
  const MERGE_PENDING: WorkItemPatch = { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending" };

  /** An item of `source` with no PR, put at `patch`. */
  async function itemOf(h: Awaited<ReturnType<typeof harness>>, source: SourceRef, patch: WorkItemPatch): Promise<WorkItem> {
    const { item } = await h.store.createWorkItem({ source, requester_id: ME, project: PROJECT_KEY, problem: "p", resources: [] }, { kind: "system", id: "system:test" });
    const r = await h.store.transition({ id: item.id, expected_version: item.version, actor: { kind: "system", id: "system:test" }, reason: "setup", patch });
    if (!r.ok) throw new Error("setup failed");
    return r.item;
  }
  const local = (n: number): SourceRef => ({ type: "local", id: `local-${n}`, link: `local:local-${n}` });
  const slack = (n: number): SourceRef => ({ type: "slack_thread", id: `T1/C1/${n}.0`, link: `https://slack.example/${n}` });
  const names = async (h: Awaited<ReturnType<typeof harness>>, it: WorkItem) => {
    const d: ApiDeps = { store: h.store, scanner: cleanScanner, clock: h.clock, lease_ms: 60_000, health: new HealthMonitor(async () => [], h.clock), commands: { actor: ME, source: "environment", token: TOKEN } };
    const body = JSON.parse((await respond(d, { method: "GET", url: `/api/v1/items/${encodeURIComponent(it.id)}`, host: HOST })).body) as { commands: { name: string }[] };
    return body.commands.map((c) => c.name);
  };

  it("the item API lists verdict for a local item with no PR, and not for a GitHub or Slack item with no PR", async () => {
    const h = await harness({ localAuth: true });
    expect(await names(h, await itemOf(h, local(1), MERGE_PENDING))).toContain("verdict");
    expect(await names(h, await itemOf(h, issueRef(2), MERGE_PENDING))).not.toContain("verdict");
    expect(await names(h, await itemOf(h, slack(3), MERGE_PENDING))).not.toContain("verdict");
    expect(await names(h, await itemOf(h, local(4), { stage: "CLOSED", close_reason: "rejected" }))).not.toContain("verdict");
  });

  it("solo, no forge and no account: a verdict app request stores one verdict on a local item with no PR and changes no state", async () => {
    const h = await harness({ localAuth: true });
    expect(await h.store.getOwner()).toBeNull();
    const it1 = await itemOf(h, local(1), MERGE_PENDING);
    await h.request("app-v", ME, "verdict", { work_item_id: it1.id, note: verdictNote("changes", "minor", "rename the flag") });
    await h.controller.tickCommands();
    expect((await h.store.listVerdicts(it1.id)).map((v) => [v.verdict, v.severity, v.reason, v.target, v.implicit, v.pr_head])).toEqual([
      ["changes", "minor", "rename the flag", "issue", false, null],
    ]);
    expect(await h.store.getWorkItem(it1.id)).toMatchObject({ stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", version: it1.version + 1 });
    const [row] = await h.store.listAppCommandRequestsForItem(it1.id, 10);
    expect(row!.refusal).toBeNull();
  });

  it("Good, Bad and Feedback on a local item: one verdict row per click through the verdict request, and no source call", async () => {
    const h = await harness({ localAuth: true });
    const it1 = await itemOf(h, local(1), MERGE_PENDING);
    const notes = [oneTapNote("good", ""), oneTapNote("bad", ""), oneTapNote("feedback", "the flag name is wrong")];
    for (const [i, note] of notes.entries()) await h.request(`app-tap-${i}`, ME, "verdict", { work_item_id: it1.id, note });
    await h.controller.tickCommands();
    expect((await h.store.listVerdicts(it1.id)).map((v) => [v.verdict, v.severity, v.reason])).toEqual([
      ["accept", "none", null], ["changes", "minor", "Bad"], ["changes", "none", "the flag name is wrong"],
    ]);
    await h.controller.tickOutbox();
    expect(h.source.comments).toEqual([]);
  });

  it("the one-tap notes: Good accept/none, Bad changes/minor, Feedback changes/none and only with text", () => {
    expect(oneTapNote("good", "")).toBe("accept none");
    expect(oneTapNote("bad", "")).toBe("changes minor Bad");
    expect(oneTapNote("bad", "too big")).toBe("changes minor too big");
    expect(oneTapNote("feedback", "  ")).toBeNull();
    expect(parseVerdict(oneTapNote("feedback", "more tests")!)).toEqual({ ok: true, value: { verdict: "changes", severity: "none", reason: "more tests" } });
  });

  it("the buttons' note is `<kind> <severity> <reason>`, which the `/verdict` parser reads back", () => {
    expect(verdictNote("accept", "none", "")).toBe("accept none");
    expect(verdictNote("changes", "major", "  rename it\n")).toBe("changes major rename it");
    for (const kind of ["accept", "changes", "reject"] as const) {
      for (const severity of ["none", "minor", "major", "critical"] as const) {
        expect(parseVerdict(verdictNote(kind, severity, "why") as string)).toEqual({ ok: true, value: { verdict: kind, severity, reason: "why" } });
      }
    }
  });
});

describe("Needs you: the verdict control (issue #513)", () => {
  const HOST = "127.0.0.1:4310";
  const TOKEN = newCsrfToken();
  const OWNER = "local:owner@example.com" as UserId;
  const MERGE_PENDING: WorkItemPatch = { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", change_ref: "42" };
  type Row = { id: string; commands?: { name: string; usage: string; allowed: boolean }[] };

  /** The page as the local owner, its grants checked by the local auth plugin, as compose.ts checks them. */
  function page(h: Awaited<ReturnType<typeof harness>>): ApiDeps {
    const auth = new OwnerAuth(h.store);
    const allowed = (action: PageAction) => auth.authorize({ user_id: OWNER, attributes: {} }, action, { kind: "project", id: PROJECT_KEY });
    return {
      store: h.store, scanner: cleanScanner, clock: h.clock, lease_ms: 60_000,
      health: new HealthMonitor(async () => [], h.clock), commands: { actor: OWNER, source: "environment", token: TOKEN, allowed },
    };
  }
  const rows = async (d: ApiDeps) => (JSON.parse((await respond(d, { method: "GET", url: "/api/v1/items?state=needs", host: HOST })).body) as { items: Row[] }).items;
  const post = (d: ApiDeps, it: WorkItem, body: unknown) =>
    respond(d, {
      method: "POST", url: `/api/v1/items/${encodeURIComponent(it.id)}/commands`, host: HOST, origin: `http://${HOST}`,
      contentType: "application/json", csrfToken: TOKEN, body: JSON.stringify(body),
    });
  const verdictOf = async (h: Awaited<ReturnType<typeof harness>>, it: WorkItem) =>
    (await h.store.listVerdicts(it.id)).map((v) => ({ verdict: v.verdict, severity: v.severity, reason: v.reason, target: v.target, implicit: v.implicit }));

  it("a waiting item with a PR offers verdict; its text, sent from the row, stores the same verdict as the item page's note box", async () => {
    const h = await harness({ localAuth: true });
    await h.store.claimOwner(OWNER);
    const fromRow = await h.itemIn(MERGE_PENDING, 1);
    const fromNoteBox = await h.itemIn(MERGE_PENDING, 2);
    const d = page(h);
    const row = (await rows(d)).find((r) => r.id === fromRow.id)!;
    expect(row.commands!.map((c) => c.name)).toContain("verdict");
    expect(row.commands!.find((c) => c.name === "verdict")).toMatchObject({ usage: "/verdict accept|changes|reject <severity> <reason>", allowed: true });
    // The row's form and the item page's note box send the same request: the command and the typed text.
    expect((await post(d, fromRow, { command: "verdict", note: "changes minor rename the flag" })).status).toBe(202);
    expect((await post(d, fromNoteBox, { command: "verdict", note: "changes minor rename the flag" })).status).toBe(202);
    await h.controller.tickCommands();
    const want = [{ verdict: "changes", severity: "minor", reason: "rename the flag", target: "issue", implicit: false }];
    expect(await verdictOf(h, fromRow)).toEqual(want);
    expect(await verdictOf(h, fromNoteBox)).toEqual(want);
    // A verdict changes no state: the row still waits for its merge.
    expect(await h.store.getWorkItem(fromRow.id)).toMatchObject({ stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending" });
  });

  it("a malformed verdict from the row is refused with the usage line, and nothing is stored", async () => {
    const h = await harness({ localAuth: true });
    await h.store.claimOwner(OWNER);
    const it1 = await h.itemIn(MERGE_PENDING, 1);
    expect((await post(page(h), it1, { command: "verdict", note: "lgtm" })).status).toBe(202);
    await h.controller.tickCommands();
    expect(await h.store.listVerdicts(it1.id)).toEqual([]);
    const [req] = await h.store.listAppCommandRequestsForItem(it1.id, 10);
    expect(req!.refusal).toContain("/verdict accept|changes|reject <none|minor|major|critical> <reason>");
  });

  it("a local item with no PR offers verdict too, and the controller takes it (decision 3)", async () => {
    const h = await harness({ localAuth: true });
    await h.store.claimOwner(OWNER);
    const actor = { kind: "system" as const, id: "system:test" };
    const source = { type: "local", id: "local-1", link: "local:local-1" };
    const { item } = await h.store.createWorkItem({ source, requester_id: OWNER, project: PROJECT_KEY, problem: "p", resources: [] }, actor);
    const r = await h.store.transition({
      id: item.id, expected_version: item.version, actor, reason: "setup", patch: { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", tier: 2 },
    });
    if (!r.ok) throw new Error("setup failed");
    const d = page(h);
    expect((await rows(d)).find((x) => x.id === item.id)!.commands!.map((c) => c.name)).toContain("verdict");
    expect((await post(d, r.item, { command: "verdict", note: "accept" })).status).toBe(202);
    await h.controller.tickCommands();
    expect(await verdictOf(h, r.item)).toEqual([{ verdict: "accept", severity: "none", reason: null, target: "issue", implicit: false }]);
  });
});

describe("the command box and pending proposals (design 09-dashboard-app)", () => {
  const HOST = "127.0.0.1:4310";
  const TOKEN = newCsrfToken();
  const OWNER = "local:owner@example.com" as UserId;
  const HELPER = "local:helper@example.com" as UserId;

  /** Proposes `/approve ship it` on the first open item for any message; counts its calls. */
  class ApproveLLM implements LLMProvider {
    calls = 0;
    async complete(req: LLMRequest): Promise<LLMResponse> {
      const label = classifierAnswer(req);
      if (label) return label;
      this.calls++;
      const id = /"id":"([^"]+)"/.exec(req.messages[0]!.content)?.[1] ?? "";
      const parsed = { kind: "commands", entries: [{ item: id, command: "approve", args: "ship it" }] };
      return { text: JSON.stringify(parsed), parsed, stop_reason: "end", usage: { input_tokens: 1, output_tokens: 1, cost_usd: null } };
    }
  }

  /** The owner and another local user; the page as `actor`; a controller with a model. */
  async function setup() {
    const { store, clock } = await newStore();
    const source = new FakeSource();
    const llm = new ApproveLLM();
    const auth = new OwnerAuth(store);
    const controller = new ControllerRole({ store, source, auth, clock, config, log: silent, scanner: cleanScanner, llm });
    await store.claimOwner(OWNER);
    const { item } = await store.createWorkItem({ source: issueRef(1), requester_id: OWNER, project: PROJECT_KEY, problem: "p", resources: [] }, { kind: "system", id: "system:test" });
    const r = await store.transition({ id: item.id, expected_version: item.version, actor: { kind: "system", id: "system:test" }, reason: "setup", patch: { ...SPEC_PENDING, tier: 2 } });
    if (!r.ok) throw new Error("setup");
    const page = (actor: UserId): UiDeps => ({
      store, scanner: cleanScanner, clock, lease_ms: 60_000, health: new HealthMonitor(async () => [], clock), commands: { actor, source: "environment", token: TOKEN },
    });
    const post = (actor: UserId, body: unknown) =>
      respond(page(actor), {
        method: "POST", url: `/api/v1/items/${encodeURIComponent(item.id)}/commands`, host: HOST, origin: `http://${HOST}`,
        contentType: "application/json", csrfToken: TOKEN, body: JSON.stringify(body),
      });
    type Detail = { proposals: { id: string; commands: { index: number; work_item_id: string; line: string }[] }[] };
    const detail = async (): Promise<Detail> =>
      JSON.parse((await respond(page(OWNER), { method: "GET", url: `/api/v1/items/${encodeURIComponent(item.id)}`, host: HOST })).body) as Detail;
    /** A sentence from the box, read by the controller; the proposal its reply names. */
    const propose = async () => {
      expect((await post(OWNER, { command: "sentence", note: "looks good, ship it" })).status).toBe(202);
      await controller.tickCommands();
      const [p] = (await detail()).proposals;
      return p!.id;
    };
    return { store, source, llm, controller, item: r.item, post, detail, propose };
  }

  it("the box sends the sentence as one app request: the UI process makes no model call and writes no other state", async () => {
    const h = await setup();
    const before = await h.store.getWorkItem(h.item.id);
    const res = await h.post(OWNER, { command: "sentence", note: "  looks good, ship it  " });
    expect(res.status).toBe(202);
    expect(h.llm.calls).toBe(0);
    expect((await h.store.listAppCommandRequestsForItem(h.item.id, 10)).map((r) => [r.command, r.args])).toEqual([
      ["sentence", { work_item_id: h.item.id, note: "looks good, ship it" }],
    ]);
    expect(await h.store.getWorkItem(h.item.id)).toEqual(before);
    expect(h.source.comments).toEqual([]);
    expect((await h.detail()).proposals).toEqual([]);
  });

  it("the controller reads it once and answers in the item's thread; the item API lists the pending proposal; no state changes", async () => {
    const h = await setup();
    const before = await h.store.getWorkItem(h.item.id);
    const id = await h.propose();
    await h.controller.tickCommands();
    expect(h.llm.calls).toBe(1);
    const replies = h.source.comments.filter((c) => c.marker.startsWith("<!-- factory:suggest:app-"));
    expect(replies).toHaveLength(1);
    expect(parseProposalMarker(replies[0]!.body)).toEqual({ id, commands: ["approve"] });
    expect((await h.detail()).proposals).toEqual([{ id, created_at: expect.any(String), commands: [{ index: 0, work_item_id: h.item.id, line: "/approve ship it" }] }]);
    expect(await h.store.getWorkItem(h.item.id)).toEqual(before);
  });

  it("Confirm all sends one app request carrying the proposal ID; the controller applies it once as the page's user", async () => {
    const h = await setup();
    const id = await h.propose();
    expect((await h.post(OWNER, { command: "proposal_confirm", proposal: id })).status).toBe(202);
    await h.controller.tickCommands();
    expect((await h.store.getWorkItem(h.item.id))!.stage).toBe("RUNNING");
    const approved = (await h.store.listStateChanges(h.item.id)).filter((c) => c.reason === "spec_approved");
    expect(approved.map((c) => [c.actor, c.detail?.note])).toEqual([[{ kind: "user", id: OWNER }, "ship it"]]);
    expect((await h.store.listCommandProposals(id)).map((r) => [r.status, r.answered_by])).toEqual([["applied", OWNER]]);
    expect((await h.detail()).proposals).toEqual([]);
    const [, confirm] = await h.store.listAppCommandRequestsForItem(h.item.id, 10);
    expect(confirm).toMatchObject({ command: "proposal_confirm", args: { work_item_id: h.item.id, proposal: id }, refusal: null });
    expect(confirm!.handled_at).not.toBeNull();
  });

  it("a Confirm all by a user who may not approve marks the row refused with one reply; Cancel marks it cancelled and applies nothing", async () => {
    const h = await setup();
    const id = await h.propose();
    expect((await h.post(HELPER, { command: "proposal_confirm", proposal: id })).status).toBe(202);
    await h.controller.tickCommands();
    expect((await h.store.getWorkItem(h.item.id))!.blocked_reason).toBe("spec_pending");
    expect((await h.store.listCommandProposals(id)).map((r) => [r.status, r.answered_by])).toEqual([["refused", HELPER]]);
    expect(h.source.comments.filter((c) => c.marker.includes("proposal-refused"))).toHaveLength(1);

    // The refused proposal is no longer pending; a second sentence makes a new one, which the owner cancels.
    const next = await h.propose();
    expect(next).not.toBe(id);
    expect((await h.post(OWNER, { command: "proposal_cancel", proposal: next })).status).toBe(202);
    await h.controller.tickCommands();
    expect((await h.store.listCommandProposals(next)).map((r) => [r.status, r.answered_by])).toEqual([["cancelled", OWNER]]);
    expect(h.source.comments.filter((c) => c.marker.includes("proposal-cancelled"))).toHaveLength(1);
    expect((await h.store.getWorkItem(h.item.id))!.blocked_reason).toBe("spec_pending");
    expect((await h.detail()).proposals).toEqual([]);
  });

  it("refuses a malformed request with 400 and stores nothing", async () => {
    const h = await setup();
    for (const body of [
      { command: "sentence" }, { command: "sentence", note: "  " }, { command: "sentence", note: "x".repeat(1001) },
      { command: "proposal_confirm" }, { command: "proposal_confirm", proposal: "prop:bad" }, { command: "proposal_cancel", proposal: "prop_a", note: "x" },
      { command: "approve", proposal: "prop_a" },
    ]) {
      expect({ body, status: (await h.post(OWNER, body)).status }).toEqual({ body, status: 400 });
    }
    expect(await h.store.listAppCommandRequestsForItem(h.item.id, 10)).toEqual([]);
  });
});

/** A JSON response for the stubbed fetch. */
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("the Merge button's Merging… state (item page and Needs-you row)", () => {
  // The web views need a DOM; this file's other tests run on node, so only these set jsdom up (vitest's own environment).
  let teardown: (() => unknown) | undefined;
  let rtl: typeof import("@testing-library/react");
  let createElement: typeof import("react").createElement;
  let QueryClient: typeof import("@tanstack/react-query").QueryClient;
  let QueryClientProvider: typeof import("@tanstack/react-query").QueryClientProvider;
  let views: { MergeButton: unknown; NeedActions: unknown; useCommandSend: (id: string) => unknown };
  let post: () => Promise<Response>;
  let itemReplies: unknown[];
  beforeAll(async () => {
    const { builtinEnvironments } = await import("vitest/environments");
    teardown = (await builtinEnvironments.jsdom.setup(globalThis, {})).teardown.bind(null, globalThis);
    rtl = await import("@testing-library/react");
    ({ createElement } = await import("react"));
    ({ QueryClient, QueryClientProvider } = await import("@tanstack/react-query"));
    // @ts-expect-error -- TS6142, as the import at the top of this file
    views = await import("../web/src/views/item-commands.js");
  });
  afterAll(async () => {
    await teardown?.();
  });
  beforeEach(() => {
    itemReplies = [];
    post = async () => json({ seq: 5 });
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string }) => {
      if (init?.method === "POST") return post();
      if (url === "/api/v1/session") return json({ as_of: "t", csrf_token: "tok", commands_enabled: true, actor: "local:me", actor_source: "environment" });
      if (url === "/api/v1/items/wi_1") return json({ item: { id: "wi_1" }, replies: itemReplies });
      return json({ error: "Not found." }, 404);
    }));
  });
  afterEach(() => {
    rtl.cleanup();
    vi.unstubAllGlobals();
  });

  const reply = (extra: Record<string, unknown> = {}) => ({ seq: 5, command: "merge", created_at: "t", handled_at: null, refusal: null, ...extra });
  const READY = { enabled: true, reason: null };
  const wrap = (client: InstanceType<typeof QueryClient>, el: unknown) => createElement(QueryClientProvider, { client }, el as never);
  const mergeButton = () => rtl.screen.getByRole("button", { name: /^Merg/ }) as unknown as { disabled: boolean; textContent: string };
  /** Holds the POST open until the returned function is called. */
  const holdPost = () => {
    let release!: () => void;
    post = () => new Promise((r) => { release = () => r(json({ seq: 5 })); });
    return () => release();
  };

  it("on the item page: Merging… and disabled from the click until the reply, then Done or the refusal", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const page = (replies: unknown[]) => wrap(client, createElement(views.MergeButton as never, { id: "wi_1", source: "local", merge: READY, replies }));
    const view = rtl.render(page([]));
    await rtl.waitFor(() => expect(mergeButton().disabled).toBe(false));
    expect(mergeButton().textContent).toBe("Merge");
    const release = holdPost();
    rtl.fireEvent.click(mergeButton() as never);
    // In flight.
    await rtl.waitFor(() => expect(mergeButton().textContent).toBe("Merging…"));
    expect(mergeButton().disabled).toBe(true);
    // Sent, not yet handled: never enabled "Merge" in the gap.
    release();
    await rtl.waitFor(() => expect(rtl.screen.getByText("sent")).toBeTruthy());
    expect(mergeButton().textContent).toBe("Merging…");
    expect(mergeButton().disabled).toBe(true);
    view.rerender(page([reply()]));
    expect(mergeButton().textContent).toBe("Merging…");
    // Handled: Done.
    view.rerender(page([reply({ handled_at: "t" })]));
    expect(rtl.screen.getByText("Done")).toBeTruthy();
    expect(mergeButton().textContent).toBe("Merge");
    // Refused: Merge again, the refusal beside it.
    view.rerender(page([reply({ handled_at: "t", refusal: "the head moved" })]));
    expect(mergeButton().textContent).toBe("Merge");
    expect(mergeButton().disabled).toBe(false);
    expect(rtl.screen.getByText("the head moved")).toBeTruthy();
  });

  it("on the item page: a failed send returns the button to Merge with the error", async () => {
    post = async () => json({ error: "the server failed" }, 500);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    rtl.render(wrap(client, createElement(views.MergeButton as never, { id: "wi_1", source: "local", merge: READY, replies: [] })));
    await rtl.waitFor(() => expect(mergeButton().disabled).toBe(false));
    rtl.fireEvent.click(mergeButton() as never);
    await rtl.waitFor(() => expect(rtl.screen.getByText("the server failed")).toBeTruthy());
    expect(mergeButton().textContent).toBe("Merge");
    expect(mergeButton().disabled).toBe(false);
  });

  it("in the Needs-you row: Merging… until the item's reply, then Merge with the refusal beside it", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function Row() {
      const cmd = views.useCommandSend("wi_1");
      return createElement(views.NeedActions as never, { id: "wi_1", title: "One", commands: [], pr: null, group: "merge", merge: READY, source: "local", checking: false, cmd, allow: [] });
    }
    rtl.render(wrap(client, createElement(Row)));
    await rtl.waitFor(() => expect(mergeButton().disabled).toBe(false));
    const release = holdPost();
    rtl.fireEvent.click(mergeButton() as never);
    await rtl.waitFor(() => expect(mergeButton().textContent).toBe("Merging…"));
    expect(mergeButton().disabled).toBe(true);
    release();
    // Sent: the row reads the item until its reply; with none yet it stays Merging… and disabled.
    await rtl.waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([u]) => u === "/api/v1/items/wi_1")).toBe(true));
    expect(mergeButton().textContent).toBe("Merging…");
    expect(mergeButton().disabled).toBe(true);
    // The controller refuses; the next read (the poll) brings the reply.
    itemReplies = [reply({ handled_at: "t", refusal: "the head moved" })];
    await client.invalidateQueries({ queryKey: ["/api/v1/items/wi_1"] });
    await rtl.waitFor(() => expect(rtl.screen.getByText("the head moved")).toBeTruthy());
    expect(mergeButton().textContent).toBe("Merge");
    expect(mergeButton().disabled).toBe(false);
  });
});
