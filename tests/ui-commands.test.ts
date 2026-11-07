import { describe, expect, it } from "vitest";
import { Controller } from "../src/core/controller.js";
import type { UserId, WorkItem, WorkItemPatch } from "../src/core/types.js";
import type { AppCommandRequest } from "../src/interfaces/factory-store.js";
import { HealthMonitor } from "../src/ui/health.js";
import { type UiDeps, respond } from "../src/ui/server.js";
import { newCsrfToken } from "../src/ui/settings-api.js";
import { FakeAuth, FakeSource, alice, cleanScanner, config, issueRef, silent, waitFor } from "./helpers/fakes.js";
import { PROJECT_KEY, newStore } from "./helpers/store.js";

// App command requests (issues #245, #282): a request row in the store is a new entry point to the comment command
// path. It lands in the command inbox too; each controller tick reads the inbox and applies `approve` with the same permission check and
// transition as a `/approve` comment; anything else is refused with one reply, keyed on the request.

/** FakeAuth lets github:1 (alice) approve, nobody else. */
const WRITER = "github:1" as UserId;
const READER = "github:666" as UserId;
const SPEC_PENDING: WorkItemPatch = { stage: "READY", blocked_on: "human", blocked_reason: "spec_pending" };
const IMPLEMENTING: WorkItemPatch = { stage: "RUNNING" };

async function harness() {
  const { store, clock } = await newStore();
  const source = new FakeSource();
  const controller = new Controller({ store, source, auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner });
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
    expect(posted[0]!.body).toBe("`/approve` was not applied: it needs write permission on this repository (`not_a_collaborator`).");
    expect(await h.store.getAppCommandRequest(r.seq)).toMatchObject({ handled_at: h.clock.now().toISOString(), refusal: posted[0]!.body });
  });

  it("a command other than approve gets one refusal reply and no state change", async () => {
    const h = await harness();
    const it1 = await h.itemIn(SPEC_PENDING, 1);
    const r = await h.request("k1", WRITER, "reject", { work_item_id: it1.id, reason: "no" });
    await h.controller.tickCommands();
    await h.controller.tickCommands();

    expect(await h.store.getWorkItem(it1.id)).toEqual(it1);
    expect(await h.store.listRuns(it1.id)).toEqual([]);
    const posted = h.source.comments.filter((c) => c.marker === h.marker(r));
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body).toBe("`reject` was not applied: only `approve` is applied from an app request; reply `/reject` on the issue instead.");
    expect((await h.store.getAppCommandRequest(r.seq))!.refusal).toBe(posted[0]!.body);
    expect(h.source.comments).toHaveLength(1);
  });

  it("an odd command name is not echoed into the reply", async () => {
    const h = await harness();
    const it1 = await h.itemIn(SPEC_PENDING, 1);
    const r = await h.request("k1", WRITER, "@everyone <b>", { work_item_id: it1.id });
    await h.controller.tickCommands();
    const posted = h.source.comments.filter((c) => c.marker === h.marker(r));
    expect(posted.map((c) => c.body)).toEqual(["The command was not applied: only `approve` is applied from an app request."]);
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
    expect((await h.store.getAppCommandRequest(r.seq))!.refusal).toMatch(/^`\/approve` was not applied: it needs write permission/);
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
    await h.controller.tickCommands();
    expect((await h.store.getWorkItem(a.id))!.stage).toBe("RUNNING");
    expect((await h.store.getWorkItem(b.id))!.stage).toBe("RUNNING");
    expect(await h.pending(ra, rb)).toEqual([]);
  });
});

describe("app command requests: the controller loop", () => {
  it("each tick reads pending requests, without waiting for the poll interval", async () => {
    const h = await harness();
    const it1 = await h.itemIn(SPEC_PENDING, 1);
    const ac = new AbortController();
    const running = h.controller.run(ac.signal);
    // The first tick polls; record the request only after it, so the next poll is poll_interval_ms away.
    await waitFor(() => h.source.polls.length > 0, "first poll");
    const polls = h.source.polls.length;
    const r = await h.request("k1", WRITER, "approve", { work_item_id: it1.id });
    for (let i = 0; i < 20 && (await h.store.getAppCommandRequest(r.seq))!.handled_at === null; i++) {
      h.clock.advance(config.tick_ms);
      await new Promise((res) => setTimeout(res, 5));
    }
    ac.abort();
    await running;
    expect(config.tick_ms * 20).toBeLessThan(config.poll_interval_ms);
    expect(h.source.polls.length).toBe(polls);
    expect((await h.store.getAppCommandRequest(r.seq))!.handled_at).not.toBeNull();
    expect((await h.store.getWorkItem(it1.id))!.stage).toBe("RUNNING");
  });
});

describe("app command requests: from the page's POST (issue #227)", () => {
  const HOST = "127.0.0.1:4310";
  const TOKEN = newCsrfToken();

  function page(h: Awaited<ReturnType<typeof harness>>, actor: UserId): UiDeps {
    return {
      store: h.store, scanner: cleanScanner, clock: h.clock, lease_ms: 60_000, prUrl: (l, n) => `https://${l}/pull/${n}`,
      health: new HealthMonitor(async () => [], h.clock), commands: { actor, token: TOKEN },
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

  it("a POST by a user without the permission, or of another command, is refused by the controller and shown in replies", async () => {
    const h = await harness();
    const it1 = await h.itemIn(SPEC_PENDING, 1);
    expect((await post(page(h, READER), it1, { command: "approve" })).status).toBe(202);
    expect((await post(page(h, WRITER), it1, { command: "reject", note: "no" })).status).toBe(202);
    await h.controller.tickCommands();
    expect((await h.store.getWorkItem(it1.id))!.blocked_reason).toBe("spec_pending");
    const r = await respond(page(h, WRITER), { method: "GET", url: `/api/v1/items/${encodeURIComponent(it1.id)}`, host: HOST });
    const replies = (JSON.parse(r.body) as { replies: { command: string; refusal: string | null; handled_at: string | null }[] }).replies;
    expect(replies.map((x) => x.command)).toEqual(["approve", "reject"]);
    expect(replies[0]!.refusal).toMatch(/^`\/approve` was not applied: it needs write permission/);
    expect(replies[1]!.refusal).toContain("only `approve` is applied from an app request");
    for (const x of replies) expect(x.handled_at).not.toBeNull();
  });
});
