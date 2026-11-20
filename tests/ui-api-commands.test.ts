// The JSON API under /api/v1: item commands on POST and GET, the In short and decisions, the merge field and the unreviewed merges.

import { describe, expect, it, vi } from "vitest";
import { commandState, commandsFor } from "../src/core/commands.js";
import { APP_COMMANDS, type PageAction } from "../src/ui/commands.js";
import type { AuthDecision } from "../src/interfaces/auth-provider.js";
import type { UserId, WorkItemId } from "../src/core/types.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { saveProjectLabel } from "../src/core/project-labels.js";
import { type UiDeps, type UiResponse, respond } from "../src/ui/server.js";
import { newCsrfToken } from "../src/ui/settings-api.js";
import { PROJECT_KEY, issue, system, w1 } from "./helpers/store.js";
import { LEASE, SECRET, ROUTES, get, json, make, patch, enqueue, seeded } from "./ui-api-fixtures.js";

describe("ui api: item commands POST (issue #227)", () => {
  const HOST = "127.0.0.1:4310";
  const ORIGIN = "http://127.0.0.1:4310";
  const ACTOR = "github:7" as UserId;
  const TOKEN = newCsrfToken();

  async function setup(actor: UserId | null = ACTOR) {
    const s = await seeded();
    s.d.commands = { actor, source: actor === null ? null : "config", token: TOKEN };
    return s;
  }

  interface PostOpts {
    path?: string; host?: string; origin?: string | null; contentType?: string | null; token?: string | null; raw?: string; bodyTooLarge?: boolean;
  }

  function post(d: UiDeps, id: string, body: unknown, o: PostOpts = {}): Promise<UiResponse> {
    return respond(d, {
      method: "POST",
      url: o.path ?? `/api/v1/items/${encodeURIComponent(id)}/commands`,
      host: o.host ?? HOST,
      origin: o.origin === null ? undefined : (o.origin ?? ORIGIN),
      contentType: o.contentType === null ? undefined : (o.contentType ?? "application/json"),
      csrfToken: o.token === null ? undefined : (o.token ?? TOKEN),
      body: o.raw ?? JSON.stringify(body),
      ...(o.bodyTooLarge ? { bodyTooLarge: true } : {}),
    });
  }

  async function appRequestRows(store: FactoryStore): Promise<number | undefined> {
    return (await store.listCliCommandsAfter(0, 100)).filter((c) => c.origin === "app").length;
  }

  async function nothingWritten(store: FactoryStore) {
    expect(await appRequestRows(store)).toBe(0);
  }

  async function refused(r: UiResponse, status: number, what: string) {
    expect(r.status, what).toBe(status);
    expect(r.headers["content-type"], what).toBe("application/json; charset=utf-8");
    expect(JSON.parse(r.body), what).toHaveProperty("error");
  }

  it("a valid request answers 202 with a request ID and writes one row for that item, acting as ui.user_id", async () => {
    const { d, store, items } = await setup();
    const r = await post(d, items.approve.id, { command: "approve", note: "  keep it small  " });
    expect(r.status).toBe(202);
    const got = JSON.parse(r.body) as { request_id: string; seq: number };
    expect(typeof got.request_id).toBe("string");
    expect(got.request_id).not.toBe("");
    expect(await appRequestRows(store)).toBe(1);
    expect(await store.getAppCommandRequest(got.seq)).toMatchObject({
      key: got.request_id, seq: got.seq, actor: ACTOR, command: "approve", args: { work_item_id: items.approve.id, note: "keep it small" },
    });
    // localhost with its own origin is accepted too; a note is optional on approve.
    const r2 = await post(d, items.approve.id, { command: "approve" }, { host: "localhost:4310", origin: "http://localhost:4310" });
    expect(r2.status).toBe(202);
    const keys = (await store.listAppCommandRequestsForItem(items.approve.id, 10)).map((x) => x.key);
    expect(keys).toEqual([got.request_id, (JSON.parse(r2.body) as { request_id: string }).request_id]);
    expect((await store.getAppCommandRequest((JSON.parse(r2.body) as { seq: number }).seq))!.args).toEqual({ work_item_id: items.approve.id });
  });

  it("a missing or wrong token is a 403 and writes nothing", async () => {
    const { d, store, items } = await setup();
    for (const token of [null, "", "nope", newCsrfToken(), `${TOKEN}x`]) {
      await refused(await post(d, items.approve.id, { command: "approve" }, { token }), 403, String(token));
    }
    await nothingWritten(store);
  });

  it("a foreign Host is a 403 and writes nothing", async () => {
    const { d, store, items } = await setup();
    for (const host of ["evil.example", "127.0.0.1.evil.example", "localhost.evil:4310", ""]) {
      await refused(await post(d, items.approve.id, { command: "approve" }, { host, origin: `http://${host}` }), 403, host);
    }
    await nothingWritten(store);
  });

  it("an Origin that is missing or not this server's own is a 403 and writes nothing", async () => {
    const { d, store, items } = await setup();
    for (const origin of [null, "", "null", "http://evil.example", "https://127.0.0.1:4310", "http://127.0.0.1:4311", "http://localhost:4310", "http://127.0.0.1"]) {
      await refused(await post(d, items.approve.id, { command: "approve" }, { origin }), 403, String(origin));
    }
    await nothingWritten(store);
  });

  it("without an actor (a non-loopback server without ui.user_id, or the route not wired) a POST is a 503 and writes nothing", async () => {
    const { d, store, items } = await setup(null);
    await refused(await post(d, items.approve.id, { command: "approve" }), 503, "no user_id");
    expect(JSON.parse((await post(d, items.approve.id, { command: "approve" })).body).error).toContain("ui.user_id");
    const { commands: _, ...unwired } = d;
    await refused(await post(unwired, items.approve.id, { command: "approve" }), 503, "unwired");
    await nothingWritten(store);
  });

  it("a Content-Type other than application/json is a 415 and writes nothing", async () => {
    const { d, store, items } = await setup();
    for (const contentType of [null, "", "text/plain", "application/x-www-form-urlencoded", "multipart/form-data", "application/jsonx"]) {
      await refused(await post(d, items.approve.id, { command: "approve" }, { contentType }), 415, String(contentType));
    }
    expect((await post(d, items.approve.id, { command: "approve" }, { contentType: "Application/JSON; charset=utf-8" })).status).toBe(202);
  });

  it("an unknown command, help and link included, is a 400 and writes nothing", async () => {
    const { d, store, items } = await setup();
    for (const command of ["help", "link", "nope", "", "APPROVE", "/approve", 1, null, undefined]) {
      await refused(await post(d, items.approve.id, { command, note: "x" }), 400, String(command));
    }
    for (const body of [[], "approve", 1, null, { command: "approve", extra: 1 }, { command: "approve", note: 5 }]) {
      await refused(await post(d, items.approve.id, body), 400, JSON.stringify(body));
    }
    await nothingWritten(store);
  });

  it("every other item command is accepted for the controller to answer", async () => {
    const { d, store, items } = await setup();
    for (const command of ["reject", "revise", "retry", "resolve", "budget", "verdict"]) {
      expect((await post(d, items.approve.id, { command, note: "why" })).status, command).toBe(202);
    }
    expect((await store.listAppCommandRequestsForItem(items.approve.id, 50)).map((r) => r.command)).toEqual([
      "reject", "revise", "retry", "resolve", "budget", "verdict",
    ]);
  });

  it("merge is accepted with no note, and a 400 with one; a 403 without the token and a 404 for no item, as every command", async () => {
    const { d, store, items } = await setup();
    await refused(await post(d, items.merge.id, { command: "merge", note: "now" }), 400, "note");
    await refused(await post(d, items.merge.id, { command: "merge" }, { token: "wrong" }), 403, "token");
    await refused(await post(d, "wi_none", { command: "merge" }), 404, "item");
    await nothingWritten(store);
    const r = await post(d, items.merge.id, { command: "merge" });
    expect(r.status).toBe(202);
    const [row] = await store.listAppCommandRequestsForItem(items.merge.id, 50);
    expect(row).toMatchObject({ actor: ACTOR, command: "merge", args: { work_item_id: items.merge.id } });
  });

  it("reject or revise with no text is a 400 and writes nothing", async () => {
    const { d, store, items } = await setup();
    for (const command of ["reject", "revise"]) {
      for (const note of [undefined, "", "   \n "]) {
        await refused(await post(d, items.approve.id, note === undefined ? { command } : { command, note }), 400, `${command} ${String(note)}`);
      }
    }
    await nothingWritten(store);
  });

  it("a POST to any other path is a JSON 405; every GET is unchanged", async () => {
    const { d, store, items } = await setup();
    const before = new Map<string, string>();
    for (const route of ROUTES) {
      const path = route.replace("ITEM", items.done.id);
      const r = await get(d, path);
      before.set(path, `${r.status} ${route.includes("ITEM") ? "" : r.body}`);
    }
    const id = encodeURIComponent(items.approve.id);
    for (const path of [
      `/api/v1/items/${id}`, `/api/v1/items/${id}/commands/x`, `/api/v1/items/${id}/commandsx`, "/api/v1/items//commands", "/api/v1/session",
      "/api/v1/overview", "/api/v1/nope", "/", "/app/", "/app/items/x", "/api/health",
    ]) {
      const r = await post(d, items.approve.id, { command: "approve" }, { path });
      await refused(r, 405, path);
      expect(r.headers.allow, path).toBe("GET, HEAD");
    }
    for (const method of ["PUT", "DELETE", "PATCH"]) {
      const r = await respond(d, { method, url: `/api/v1/items/${id}/commands`, host: HOST, origin: ORIGIN, contentType: "application/json", csrfToken: TOKEN, body: "{}" });
      expect(r.status, method).toBe(405);
    }
    await nothingWritten(store);
    for (const route of ROUTES) {
      const path = route.replace("ITEM", items.done.id);
      const r = await get(d, path);
      expect(`${r.status} ${route.includes("ITEM") ? "" : r.body}`, path).toBe(before.get(path));
    }
  });

  it("a body that is not JSON is a 400; an unknown item id is a 404; a body over 16 KB is a 413; each writes nothing", async () => {
    const { d, store, items } = await setup();
    for (const raw of ["not json", "", "{", "{'command':'approve'}"]) await refused(await post(d, items.approve.id, null, { raw }), 400, raw);
    for (const id of ["wi_nope", "%E0%A4%A"]) {
      await refused(await post(d, id, { command: "approve" }, { path: `/api/v1/items/${id}/commands` }), 404, id);
    }
    await refused(await post(d, items.approve.id, { command: "approve" }, { bodyTooLarge: true }), 413, "flag");
    const big = JSON.stringify({ command: "approve", note: "x".repeat(1000), pad: "y".repeat(16 * 1024) });
    await refused(await post(d, items.approve.id, null, { raw: big }), 413, "long body");
    await nothingWritten(store);
  });

  it("a note over 2000 characters on approve is a 400 and writes nothing; 2000 is accepted", async () => {
    const { d, store, items } = await setup();
    await refused(await post(d, items.approve.id, { command: "approve", note: "n".repeat(2001) }), 400, "2001");
    await nothingWritten(store);
    expect((await post(d, items.approve.id, { command: "approve", note: "n".repeat(2000) })).status).toBe(202);
  });

  it("GET /api/v1/session gives the token behind the Host guard; 404 when commands are not wired", async () => {
    const { d } = await setup();
    const s = await json<{ csrf_token: string; commands_enabled: boolean }>(d, "/api/v1/session");
    expect(s).toMatchObject({ csrf_token: TOKEN, commands_enabled: true, actor: ACTOR, actor_source: "config" });
    expect((await get(d, "/api/v1/session", { host: "evil.example" })).status).toBe(403);
    expect((await get(d, "/api/v1/session", { host: "evil.example" })).body).not.toContain(TOKEN);
    d.commands = { actor: null, source: null, token: TOKEN };
    expect((await json<{ commands_enabled: boolean }>(d, "/api/v1/session")).commands_enabled).toBe(false);
    const { commands: _, ...unwired } = d;
    expect((await get(unwired, "/api/v1/session")).status).toBe(404);
  });
});

describe("ui api: item commands and replies on GET /api/v1/items/:id (issue #227)", () => {
  type Detail = { commands: { name: string; usage: string; description: string; allowed: boolean; reason: string | null }[]; replies: Record<string, unknown>[] };

  it("commands are the footer table's commands for the item's state the page can send: never /help or /link", async () => {
    const { d, store, items } = await seeded();
    for (const it of Object.values(items)) {
      const cur = (await store.getWorkItem(it.id))!;
      const body = await json<Detail>(d, `/api/v1/items/${encodeURIComponent(it.id)}`);
      const want = commandsFor(commandState(cur)).filter((c) => c.name !== "help").map((c) => ({ name: c.name, usage: c.usage, description: c.description, allowed: true, reason: null }));
      expect(body.commands, it.id).toEqual(want);
      // Every listed command is one the commands route accepts, so no button can only be refused.
      for (const c of body.commands) expect(APP_COMMANDS, `${it.id} ${c.name}`).toContain(c.name);
    }
    const approve = await json<Detail>(d, `/api/v1/items/${encodeURIComponent(items.approve.id)}`);
    expect(approve.commands.map((c) => c.name)).toContain("approve");
    const done = await json<Detail>(d, `/api/v1/items/${encodeURIComponent(items.done.id)}`);
    expect(done.commands.map((c) => c.name)).not.toContain("approve");
  });

  it("replies are the item's stored requests with seq, command, times and the withheld refusal; the note is only in the thread", async () => {
    const { d, store, items, clock } = await seeded();
    const note = "private note text";
    const a = (await store.recordAppCommandRequest({ key: "a", actor: "github:7" as UserId, command: "approve", args: { work_item_id: items.approve.id, note } })).request;
    const b = (await store.recordAppCommandRequest({ key: "b", actor: "github:7" as UserId, command: "retry", args: { work_item_id: items.approve.id } })).request;
    await store.recordAppCommandRequest({ key: "c", actor: "github:7" as UserId, command: "approve", args: { work_item_id: items.merge.id } });
    clock.advance(1000);
    await store.markAppCommandRequest(b.seq, `\`retry\` was not applied: ${SECRET}.`);
    const r = await get(d, `/api/v1/items/${encodeURIComponent(items.approve.id)}`);
    expect(r.body).not.toContain(SECRET);
    const body = JSON.parse(r.body) as Detail & { thread: { kind: string; body: string }[] };
    expect(JSON.stringify(body.replies)).not.toContain(note);
    expect(body.thread.filter((e) => e.kind === "approve").map((e) => e.body)).toEqual([note]);
    expect(body.replies).toEqual([
      { seq: a.seq, command: "approve", created_at: a.created_at, handled_at: null, refusal: null },
      { seq: b.seq, command: "retry", created_at: b.created_at, handled_at: clock.now().toISOString(), refusal: "[withheld: github_token]" },
    ]);
    expect((await json<Detail>(d, `/api/v1/items/${encodeURIComponent(items.queued.id)}`)).replies).toEqual([]);
  });
});

describe("ui api: the waiting spec's In short and decisions on GET /api/v1/items/:id (issue #526)", () => {
  type Detail = { spec: { in_short: string; decisions: Record<string, unknown>[] } | null };
  const IN_SHORT = "AS-IS: nothing checks the scope.\nTO-BE: CI checks the scope.";
  const SPEC = {
    in_short: IN_SHORT, problem: "p", done_criteria: ["d"], desired_output: "o", in_scope: [], out_of_scope: [], allowed_paths: ["src/"],
    files_to_change: [], tier: 2, tier_reason: "r", estimated_lines: 10, estimated_files: 1,
    decisions: [
      { question: "Fail the job, or only warn?", reason: `It blocks merges ${SECRET}`, options: ["Fail the job", "Only warn"], default: "Only warn", owner_only: false },
      { question: "Name the step?", reason: "It shows in CI.", options: [], default: "scope", owner_only: true },
    ],
  };

  /** An item whose triage run wrote `spec`, applied (acknowledged) with `patch`. */
  async function triaged(store: FactoryStore, n: number, spec: object, p: Parameters<FactoryStore["transition"]>[0]["patch"]) {
    const it = await make(store, n, `Item ${n}`);
    await enqueue(store, it, "triage", `t:${n}`);
    // The seeded store has other triage runs queued: claim until this item's.
    let run = (await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: LEASE }))!;
    while (run.work_item_id !== it.id) run = (await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: LEASE }))!;
    await store.completeRun(run.id, run.lease!.token, { status: "succeeded", summary: "s", data: { spec } });
    const cur = (await store.getWorkItem(it.id))!;
    const r = await store.transition({ id: it.id, expected_version: cur.version, patch: p, actor: system, reason: "triaged", ack_run: run.id });
    if (!r.ok) throw new Error(r.reason);
    return it;
  }

  it("returns in_short and each decision's question, options, default, reason and owner_only, every text through the Withholder", async () => {
    const { d, store } = await seeded();
    const it = await triaged(store, 50, SPEC, { stage: "READY", blocked_on: "human", blocked_reason: "spec_pending" });
    const r = await get(d, `/api/v1/items/${encodeURIComponent(it.id)}`);
    expect(r.body).not.toContain(SECRET);
    expect((JSON.parse(r.body) as Detail).spec).toEqual({
      in_short: IN_SHORT,
      decisions: [
        { question: "Fail the job, or only warn?", options: ["Fail the job", "Only warn"], default: "Only warn", reason: "[withheld: github_token]", owner_only: false, option_changes: [] },
        { question: "Name the step?", options: [], default: "scope", reason: "It shows in CI.", owner_only: true, option_changes: [] },
      ],
    });
  });

  it("a layout decision carries its layout marker; the others have none", async () => {
    const { d, store } = await seeded();
    const layout = { question: "Which layout?", reason: "The page shape.", options: ["[Header]\n[Cards]", "[Header]\n[List]"], default: "[Header]\n[List]", owner_only: false, layout: true };
    const it = await triaged(store, 53, { ...SPEC, decisions: [...SPEC.decisions, layout] }, { stage: "READY", blocked_on: "human", blocked_reason: "spec_pending" });
    const body = await json<Detail>(d, `/api/v1/items/${encodeURIComponent(it.id)}`);
    expect(body.spec!.decisions.map((x) => x.layout)).toEqual([undefined, undefined, true]);
    expect(body.spec!.decisions[2]).toMatchObject({ question: "Which layout?", options: layout.options, default: layout.default });
  });

  it("a stored plain-text decision from an older triage is a question with no options, default or reason", async () => {
    const { d, store } = await seeded();
    const it = await triaged(store, 51, { ...SPEC, decisions: ["Ship behind a flag?"] }, { stage: "READY", blocked_on: "human", blocked_reason: "max_revisions" });
    const body = await json<Detail>(d, `/api/v1/items/${encodeURIComponent(it.id)}`);
    expect(body.spec!.decisions).toEqual([{ question: "Ship behind a flag?", options: [], default: null, reason: null, owner_only: true, option_changes: [] }]);
  });

  it("is null for an item whose spec is not waiting for approval, or with no applied triage run", async () => {
    const { d, store, items } = await seeded();
    const it = await triaged(store, 52, SPEC, { stage: "RUNNING" });
    expect((await json<Detail>(d, `/api/v1/items/${encodeURIComponent(it.id)}`)).spec).toBeNull();
    expect((await json<Detail>(d, `/api/v1/items/${encodeURIComponent(items.approve.id)}`)).spec).toBeNull();
  });
});

describe("ui api: the merge field on /api/v1/items and /api/v1/items/:id (the Merge button)", () => {
  const TOKEN = newCsrfToken();
  const ACTOR = "local:me" as UserId;
  const MERGE_PENDING = { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending" } as const;
  type Merge = { enabled: boolean; reason: string | null };

  async function localItem(store: FactoryStore, n: number) {
    return (await store.createWorkItem({ ...issue(n), source: { type: "local", id: `local-${n}`, link: `local:local-${n}` } }, system)).item;
  }
  /** The item's `merge` on its page and on its list row: always the same. */
  const mergeOf = async (d: UiDeps, id: WorkItemId): Promise<Merge> => {
    const page = (await json<{ item: { merge: Merge } }>(d, `/api/v1/items/${encodeURIComponent(id)}`)).item.merge;
    const row = (await json<{ items: { id: string; merge: Merge }[] }>(d, "/api/v1/items?closed=1")).items.find((i) => i.id === id);
    if (row) expect(row.merge, id).toEqual(page);
    return page;
  };
  const enabled = { enabled: true, reason: null };
  const off = (reason: string) => ({ enabled: false, reason });

  it("enabled for a GitHub PR or a local item waiting for its merge, for a user allowed approve_merge", async () => {
    const { d, store, items } = await seeded();
    const asked = vi.fn(async (_action: PageAction): Promise<AuthDecision> => ({ allow: true }));
    d.commands = { actor: ACTOR, source: "config", token: TOKEN, allowed: asked };
    await store.recordMergeCheck({ work_item_id: items.merge.id, mergeable: true, conflicts: [], head_sha: "a".repeat(40), base_sha: "b".repeat(40) });
    const local = await patch(store, await localItem(store, 40), MERGE_PENDING);

    expect(await mergeOf(d, items.merge.id)).toEqual(enabled);
    expect(await mergeOf(d, local.id)).toEqual(enabled);
    // A list asks each grant at most once, however many rows it has.
    asked.mockClear();
    await json(d, "/api/v1/items?closed=1");
    const actions = asked.mock.calls.map(([a]) => a);
    expect(actions).toContain("approve_merge");
    expect(new Set(actions).size).toBe(actions.length);
  });

  it("disabled with a reason: not waiting, merge check running, conflicts, no forge, no sandbox, commands off, not allowed", async () => {
    const { d, store, items } = await seeded();
    let allowed = true;
    d.commands = { actor: ACTOR, source: "config", token: TOKEN, allowed: async () => (allowed ? { allow: true } : { allow: false, reason: "no_role" }) };
    const local = await patch(store, await localItem(store, 40), MERGE_PENDING);

    for (const it of [items.approve, items.done, items.running]) expect(await mergeOf(d, it.id), it.id).toEqual(off("not waiting for a merge"));
    // No stored merge check result for the PR's head yet.
    expect(await mergeOf(d, items.merge.id)).toEqual(off("merge check running"));
    await store.recordMergeCheck({ work_item_id: items.merge.id, mergeable: false, conflicts: ["a.ts", "b.ts"], head_sha: "a".repeat(40), base_sha: "b".repeat(40) });
    expect(await mergeOf(d, items.merge.id)).toEqual(off("2 conflicting files"));
    // A local item has no merge check: its own merge refuses a conflict.
    expect(await mergeOf(d, local.id)).toEqual(enabled);

    d.commands = { ...d.commands, forge: false, localMerge: false };
    expect(await mergeOf(d, items.merge.id)).toEqual(off("no forge selected"));
    expect(await mergeOf(d, local.id)).toEqual(off("no sandbox that can merge"));
    d.commands = { ...d.commands, forge: true, localMerge: true };

    allowed = false;
    expect(await mergeOf(d, local.id)).toEqual(off("not allowed to merge (approve_merge)"));
    d.commands = { actor: ACTOR, source: "config", token: TOKEN };
    expect(await mergeOf(d, local.id)).toEqual(off("not allowed to merge (approve_merge)"));
    d.commands = { actor: null, source: null, token: TOKEN, allowed: async () => ({ allow: true }) };
    expect(await mergeOf(d, local.id)).toEqual(off("commands are off"));
    const { commands: _, ...unwired } = d;
    expect(await mergeOf(unwired, local.id)).toEqual(off("commands are off"));
  });

  it("a local item that already has a PR merges through its PR: it needs a forge, not a sandbox that can merge", async () => {
    const { d, store } = await seeded();
    d.commands = { actor: ACTOR, source: "config", token: TOKEN, allowed: async () => ({ allow: true }), forge: true, localMerge: false };
    const withPr = await patch(store, await localItem(store, 41), { ...MERGE_PENDING, change_ref: "77" });
    await store.recordMergeCheck({ work_item_id: withPr.id, mergeable: true, conflicts: [], head_sha: "a".repeat(40), base_sha: "b".repeat(40) });

    expect(await mergeOf(d, withPr.id)).toEqual(enabled);
    d.commands = { ...d.commands, forge: false, localMerge: true };
    expect(await mergeOf(d, withPr.id)).toEqual(off("no forge selected"));
  });
});

describe("ui api: local merge check (issue #248)", () => {
  type Check = { state: string; conflicts: string[]; head_sha: string | null; base_sha: string | null; checked_at: string | null } | null;
  type Row = { id: string; merge_check: Check };
  const HEAD = "a".repeat(40);
  const BASE = "b".repeat(40);

  it("a ready-to-merge item with no result is checking; other items have no merge check", async () => {
    const { d, items } = await seeded();
    const list = (await json<{ items: Row[] }>(d, "/api/v1/items")).items;
    expect(list.find((i) => i.id === items.merge.id)!.merge_check).toEqual({ state: "checking", conflicts: [], head_sha: null, base_sha: null, checked_at: null });
    expect(list.find((i) => i.id === items.approve.id)!.merge_check).toBeNull();
    expect((await json<{ item: Row }>(d, `/api/v1/items/${items.approve.id}`)).item.merge_check).toBeNull();
  });

  it("returns the stored result on the list and the item page, file names through the Withholder", async () => {
    const { d, store, clock, items } = await seeded();
    await store.recordMergeCheck({ work_item_id: items.merge.id, mergeable: false, conflicts: ["src/a.ts", `leak-${SECRET}.txt`], head_sha: HEAD, base_sha: BASE });
    const want = { state: "conflicts", conflicts: ["src/a.ts", "[withheld: github_token]"], head_sha: HEAD, base_sha: BASE, checked_at: clock.now().toISOString() };
    const list = (await json<{ items: Row[] }>(d, "/api/v1/items")).items;
    expect(list.find((i) => i.id === items.merge.id)!.merge_check).toEqual(want);
    expect((await json<{ item: Row }>(d, `/api/v1/items/${items.merge.id}`)).item.merge_check).toEqual(want);
    expect(JSON.stringify(await json(d, "/api/v1/items"))).not.toContain(SECRET);
  });

  it("a clean result is mergeable; a result for an older head than the recorded one is checking", async () => {
    const { d, store, items } = await seeded();
    await store.recordMergeCheck({ work_item_id: items.merge.id, mergeable: true, conflicts: [], head_sha: HEAD, base_sha: BASE });
    const row = async () => (await json<{ items: Row[] }>(d, "/api/v1/items")).items.find((i) => i.id === items.merge.id)!.merge_check!;
    expect((await row()).state).toBe("mergeable");
    await store.recordPrHead({ id: items.merge.id, expected_head: null, head_sha: "c".repeat(40), manual: null });
    expect((await row()).state).toBe("checking");
  });

  it("reads the result with store read methods only", async () => {
    const calls: string[] = [];
    const spy = (s: FactoryStore): FactoryStore =>
      new Proxy(s, {
        get(target, prop, receiver) {
          const v = Reflect.get(target, prop, receiver) as unknown;
          if (typeof v !== "function") return v;
          return (...args: unknown[]) => {
            calls.push(String(prop));
            return (v as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      });
    const { d, items } = await seeded({ store: spy });
    calls.length = 0;
    await json(d, "/api/v1/items");
    await json(d, `/api/v1/items/${items.merge.id}`);
    expect(calls).toContain("listMergeChecks");
    expect(calls).toContain("getMergeCheck");
    expect(calls.filter((n) => !/^(get|list|count)[A-Z]/.test(n))).toEqual([]);
  });
});

describe("ui api: unreviewed merges", () => {
  type Merge = { project: string; change_ref: string; change_url: string | null; merge_sha: string; merged_by: string; recorded_at: string };
  const list = async (d: UiDeps, q = "") => (await json<{ merges: Merge[] }>(d, `/api/v1/unreviewed-merges${q}`)).merges;
  const rec = (store: FactoryStore, n: number, merger: string | null = null, sha = `${n}`.repeat(40)) =>
    store.recordUnreviewedMerge({ project: PROJECT_KEY, change_ref: String(n), merge_sha: sha, merger_id: merger as UserId | null });

  it("lists rows newest first with the label, a short sha and the merger id, never the project key", async () => {
    const { d, store, clock } = await seeded();
    await saveProjectLabel(store, { key: PROJECT_KEY, label: "github.com/o/r" });
    await rec(store, 1, "github:7");
    clock.advance(1000);
    await rec(store, 2, null);
    const gh = { ...d, plugins: { issues: "github" } } as UiDeps;
    const rows = await list(gh);
    expect(rows.map((r) => r.change_ref)).toEqual(["2", "1"]);
    expect(rows[1]).toMatchObject({ project: "github.com/o/r", merge_sha: "1111111", merged_by: "github:7", change_url: null });
    expect(rows[0]!.merged_by).toBe("unknown");
    expect(typeof rows[0]!.recorded_at).toBe("string");
    expect(JSON.stringify(rows)).not.toContain(PROJECT_KEY);
  });

  it("limit: default 50, at most 200, and a bad value is a 400", async () => {
    const { d, store } = await seeded();
    for (let n = 1; n <= 205; n++) await rec(store, n);
    expect(await list(d)).toHaveLength(50);
    expect(await list(d, "?limit=3")).toHaveLength(3);
    expect(await list(d, "?limit=1000")).toHaveLength(200);
    for (const bad of ["0", "-1", "x"]) expect((await get(d, `/api/v1/unreviewed-merges?limit=${bad}`)).status).toBe(400);
  });

  it("no PR link: the store keeps none for an unreviewed merge, so the ref is text, with or without plugin and label", async () => {
    const { d, store } = await seeded();
    await rec(store, 1);
    await saveProjectLabel(store, { key: PROJECT_KEY, label: "github.com/o/r" });
    for (const deps of [d, { ...d, plugins: { issues: "github" } } as UiDeps, { ...d, plugins: { issues: null } } as UiDeps]) {
      const [row] = await list(deps);
      expect(row).toMatchObject({ change_ref: "1", change_url: null });
      expect(Object.keys(row!)).not.toContain("pr_number");
    }
  });

  it("strings from the store go through the Withholder", async () => {
    const { d, store } = await seeded();
    await rec(store, 1, `github:${SECRET}`, SECRET);
    const r = await get(d, "/api/v1/unreviewed-merges");
    expect(r.body).not.toContain(SECRET);
    expect((await list(d))[0]).toMatchObject({ merged_by: "[withheld: github_token]", merge_sha: "[withheld: github_token]" });
  });

  it("overview counts the rows recorded in the last 7 days", async () => {
    const { d, store, clock } = await seeded();
    const count = async () => (await json<{ unreviewed_merges_7d: number }>(d, "/api/v1/overview")).unreviewed_merges_7d;
    expect(await count()).toBe(0);
    await rec(store, 1);
    clock.advance(8 * 24 * 3600_000);
    await rec(store, 2);
    expect(await count()).toBe(1);
  });
});
