import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { uiPort } from "../src/compose.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import type { UserId, WorkItem, WorkItemId } from "../src/core/types.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { readFactoryStatus } from "../src/ui/factory-status.js";
import { HealthMonitor } from "../src/ui/health.js";
import { type ApiDeps, type UiRequest, type UiServer, respond, startUi } from "../src/ui/server.js";
import { TASK_DELETE_PATH, TASK_DONE_PATH, TASK_EDIT_PATH, TASK_SUB_PATH } from "../src/ui/tasks-api.js";
import { newCsrfToken } from "../src/ui/settings-api.js";
import { saveProjectLabel } from "../src/core/project-labels.js";
import { FakeAuth, FakeSource, PROJECT, alice, config, issueRef, silent, cleanScanner } from "./helpers/fakes.js";
import { issue, newStore, system, w1, w2 } from "./helpers/store.js";

const LEASE = 60_000;
// Built here so no secret-shaped literal sits in the repository.
const SECRET = `ghp_${"Ab3".repeat(12)}`;
const HEALTHY = [{ ok: true, msg: "secret file is outside the repository" }];

interface Page {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** node:http, not fetch: fetch will not send a custom Host header. */
function get(port: number, path: string, opts: { method?: string; host?: string | null } = {}): Promise<Page> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (opts.host !== null) headers.host = opts.host ?? `127.0.0.1:${port}`;
    const req = request({ host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers, setHost: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function setTitle(store: FactoryStore, n: number, title: string | null) {
  return (await store.createWorkItem({ ...issue(n), ...(title === null ? {} : { title }) }, system)).item;
}

async function patch(store: FactoryStore, item: WorkItem, p: Parameters<FactoryStore["transition"]>[0]["patch"]) {
  const cur = (await store.getWorkItem(item.id))!;
  const r = await store.transition({ id: item.id, expected_version: cur.version, patch: p, actor: system, reason: "seed" });
  if (!r.ok) throw new Error(r.reason);
  return r.item;
}

/** Seeds one item per section, starts the page on port 0. */
async function seeded() {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  // Stored before the PR is set, as build() does at startup: the store writes change_url from it.
  await saveProjectLabel(store, PROJECT);

  const waiting = await setTitle(store, 1, "Spec for <script>alert(1)</script> the gate");
  await patch(store, waiting, { stage: "READY", blocked_on: "human", blocked_reason: "spec_pending" });
  const merging = await setTitle(store, 2, "Merge me");
  await patch(store, merging, { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", change_ref: "42", tier: 2 });

  // Finished runs: one succeeded with tokens, one failed carrying a secret-shaped string.
  const done = await setTitle(store, 3, "Done item");
  await store.transition({ id: done.id, expected_version: 1, patch: {}, actor: system, reason: "x", enqueue: { kind: "triage", idempotency_key: "done:t" } });
  let r = (await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: LEASE }))!;
  clock.advance(90_000);
  await store.completeRun(r.id, r.lease!.token, { status: "succeeded", summary: "ok", data: { tokens: 1234 } });
  await store.transition({ id: done.id, expected_version: 2, patch: {}, actor: system, reason: "x", enqueue: { kind: "implement", idempotency_key: "done:i" } });
  r = (await store.claimRun({ worker_id: w1, kinds: ["implement"], lease_ms: LEASE }))!;
  await store.completeRun(r.id, r.lease!.token, { status: "failed", error_code: "agent_error", detail: `push failed: token ${SECRET} rejected`, infra: false });
  await patch(store, done, { stage: "CLOSED", close_reason: "completed", token_cost: 1234 });

  // Running: claimed, then its heartbeat goes stale.
  const running = await setTitle(store, 4, "Running item");
  await store.transition({ id: running.id, expected_version: 1, patch: { stage: "RUNNING" }, actor: system, reason: "x", enqueue: { kind: "implement", idempotency_key: "run:i" } });
  const claimed = (await store.claimRun({ worker_id: w2, kinds: ["implement"], lease_ms: LEASE }))!;

  // Queued, with no title (an item from before titles existed shows its source id).
  const queued = await setTitle(store, 5, null);
  await store.transition({ id: queued.id, expected_version: 1, patch: {}, actor: system, reason: "x", enqueue: { kind: "triage", idempotency_key: "q:t" } });

  clock.advance(LEASE + 5_000);

  const scanner = new PatternEgressScanner(async () => []);
  const ui = await startUi(
    { store, scanner, clock, lease_ms: LEASE, health: new HealthMonitor(async () => HEALTHY, clock) },
    0,
  );
  servers.push(ui);
  return { clock, store, ui, port: ui.port, items: { waiting, merging, done, running, queued }, claimed };
}

const servers: UiServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

describe("ui: read-only status page", () => {
  it("binds to 127.0.0.1 only", async () => {
    const { ui } = await seeded();
    expect(ui.address).toBe("127.0.0.1");
    expect(ui.port).toBeGreaterThan(0);
  });

  it("accepts only GET and HEAD, 404s unknown paths, and refuses foreign Host headers", async () => {
    const { port, items } = await seeded();
    for (const method of ["POST", "PUT", "DELETE"]) {
      const res = await get(port, "/api/health", { method });
      expect(res.status, method).toBe(405);
      expect(res.headers.allow).toBe("GET, HEAD");
    }
    const apiHead = await get(port, "/api/health", { method: "HEAD" });
    expect(apiHead.status).toBe(200);
    expect(apiHead.body).toBe("");
    for (const host of ["evil.example", `evil.example:${port}`]) {
      const res = await get(port, "/api/health", { host });
      expect(res.status, host).toBe(403);
      expect(res.body).not.toContain("secret file");
    }

    expect((await get(port, "/nope")).status).toBe(404);
    expect((await get(port, "/items/wi_missing")).status).toBe(404);
    expect((await get(port, `/items/${items.done.id}/x`)).status).toBe(404);

    for (const host of [`localhost:${port}`, "localhost", `127.0.0.1:${port}`]) {
      expect((await get(port, "/api/v1/items", { host })).status, host).toBe(200);
    }
    for (const host of ["evil.example", `evil.example:${port}`, `127.0.0.1.evil.example:${port}`, "localhost.evil.example"]) {
      const res = await get(port, "/api/v1/items", { host });
      expect(res.status, String(host)).toBe(403);
      expect(res.body).not.toContain("Merge me");
    }
    // No Host header at all: node:http rejects it with 400 before the handler runs (requireHostHeader).
    const noHost = await get(port, "/api/v1/items", { host: null });
    expect(noHost.status).toBe(400);
    expect(noHost.body).not.toContain("Merge me");
  });

  it("reading every page and API route writes nothing to the store", async () => {
    const { port, store, items } = await seeded();
    const ids = Object.values(items).map((i) => i.id as WorkItemId);
    const snapshot = async () =>
      Promise.all(ids.map(async (id) => ({ item: await store.getWorkItem(id), runs: await store.listRuns(id), sc: await store.listStateChanges(id) })));
    const before = await snapshot();
    for (const path of ["/api/v1/items", "/api/health", ...ids.map((id) => `/api/v1/items/${id}`), "/nope"]) await get(port, path);
    expect(await snapshot()).toEqual(before);
  });
});

describe("ui: config and intake", () => {
  it("ui.port defaults to 4310 and must be a valid port", () => {
    expect(uiPort(undefined)).toBe(4310);
    expect(uiPort({})).toBe(4310);
    expect(uiPort({ port: 5000 })).toBe(5000);
    for (const port of [0, -1, 70000, 1.5, "4310"]) expect(() => uiPort({ port } as never)).toThrow(/ui\.port/);
  });

  it("intake records the issue title; problem is unchanged", async () => {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const source = new FakeSource();
    const controller = new ControllerRole({ store, source, auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner });
    source.queue.push({ kind: "item_requested", source: issueRef(9), requester: alice, title: "Status page", body: "please" });
    await controller.tickIntake();
    const item = (await store.getWorkItemBySource("github_issue", issueRef(9).id))!;
    expect(item.title).toBe("Status page");
    expect(item.problem).toBe("Status page\n\nplease");
  });
});

async function startOn(store: FactoryStore, clock: FakeClock) {
  await saveProjectLabel(store, PROJECT); // as build() does at startup
  const ui = await startUi(
    { store, scanner: new PatternEgressScanner(async () => []), clock, lease_ms: LEASE, health: new HealthMonitor(async () => HEALTHY, clock) },
    0,
  );
  servers.push(ui);
  return ui.port;
}

describe("ui: the app is the default", () => {
  it("/ sends the browser to /app/ (302, no body)", async () => {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const port = await startOn(store, clock);
    const root = await get(port, "/");
    expect(root.status).toBe(302);
    expect(root.headers.location).toBe("/app/");
  });
});

describe("ui: factory status file", () => {
  it("reads the status file; a dead child pid reads as stopped; a missing file as null", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-ui-status-"));
    const file = join(dir, "supervisor.json");
    expect(await readFactoryStatus(file, 3)).toBeNull();
    writeFileSync(file, JSON.stringify({ state: "draining", rev: "a", target_rev: "b", child_pid: 99, since: "x" }));
    expect(await readFactoryStatus(file, 3, () => true)).toMatchObject({ state: "draining", workers: 3 });
    expect(await readFactoryStatus(file, 3, () => false)).toMatchObject({ state: "stopped", child_pid: null });
  });
});

describe("ui: item commands over the real socket (issue #227)", () => {
  /** node:http, so the Host header is ours; a POST with a JSON body and the guard headers. */
  function send(port: number, path: string, body: string, headers: Record<string, string>): Promise<Page> {
    return new Promise((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port, path, method: "POST", headers: { host: `127.0.0.1:${port}`, ...headers }, setHost: false },
        (res) => {
          let out = "";
          res.setEncoding("utf8");
          res.on("data", (c: string) => (out += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: out }));
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  }

  it("listens on 127.0.0.1 only, reads the guard headers and the body, caps it at 16 KB, and never logs the token", async () => {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const it0 = (await store.createWorkItem(issue(1), system)).item;
    const token = newCsrfToken();
    const logged: string[] = [];
    const spies = (["log", "error", "warn", "info"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(" "))));
    try {
      const ui = await startUi(
        {
          store, scanner: new PatternEgressScanner(async () => []), clock, lease_ms: LEASE,
          health: new HealthMonitor(async () => HEALTHY, clock), commands: { actor: "github:7" as UserId, source: "config", token },
        },
        0,
      );
      servers.push(ui);
      expect(ui.address).toBe("127.0.0.1");
      const session = JSON.parse((await get(ui.port, "/api/v1/session")).body) as { csrf_token: string };
      expect(session.csrf_token).toBe(token);
      const path = `/api/v1/items/${encodeURIComponent(it0.id)}/commands`;
      const headers = { "content-type": "application/json", origin: `http://127.0.0.1:${ui.port}`, "x-csrf-token": token };
      const ok = await send(ui.port, path, JSON.stringify({ command: "approve", note: "go" }), headers);
      expect(ok.status).toBe(202);
      expect((await send(ui.port, path, JSON.stringify({ command: "approve" }), { ...headers, "x-csrf-token": "" })).status).toBe(403);
      expect((await send(ui.port, path, JSON.stringify({ command: "approve" }), { ...headers, origin: "http://evil.example" })).status).toBe(403);
      const big = await send(ui.port, path, JSON.stringify({ command: "approve", pad: "x".repeat(17 * 1024) }), headers);
      expect(big.status).toBe(413);
      const other = await send(ui.port, "/api/v1/overview", "{}", headers);
      expect(other.status).toBe(405);
      expect(other.headers["content-type"]).toBe("application/json; charset=utf-8");
      expect((await store.listAppCommandRequestsForItem(it0.id, 10)).map((r) => r.args)).toEqual([{ work_item_id: it0.id, note: "go" }]);
    } finally {
      for (const s of spies) s.mockRestore();
    }
    expect(logged.join("\n")).not.toContain(token);
  });

  it("the server binds a fixed 127.0.0.1 and the ui command never prints the token", () => {
    const server = readFileSync(join(import.meta.dirname, "../src/ui/server.ts"), "utf8");
    expect(server).toContain('const BIND = "127.0.0.1";');
    expect(server).toContain("server.listen(port, BIND,");
    const ui = readFileSync(join(import.meta.dirname, "../src/cli/handlers/ui/ui.command.ts"), "utf8");
    expect(ui).toContain("commands: parts.commands");
    expect(ui).not.toMatch(/console\.\w+\([^)]*(token|parts\.commands)/);
  });
});

describe("ui: the Tasks page's row actions (design 02-tasks)", () => {
  const HOST = "127.0.0.1:4310";
  const ACTOR = "local:owner@example.com" as UserId;
  const SUB_ID = "tk_sub0123456789";

  /** A store with a parent (one open sub-task), a plain task, and a done task; `post` sends through every guard. */
  async function tasks() {
    const clock = new FakeClock(new Date("2026-11-12T09:00:00"));
    const { store } = await newStore(clock);
    const token = newCsrfToken();
    const d: ApiDeps = {
      store, scanner: cleanScanner, clock, lease_ms: LEASE, health: new HealthMonitor(async () => [], clock),
      commands: { actor: ACTOR, source: "environment" as const, token },
    };
    const add = (id: string, title: string) => store.addTask({ id, title, list: null, priority: null, due: null, due_time: null, recurrence: null, created_by: ACTOR });
    await add("tk_parent", "plan the trip");
    await add("tk_plain", "call the bank");
    await add("tk_done", "old chore");
    await store.completeTask("tk_done");
    const child = await store.addSubTask("tk_parent", { id: "tk_child", title: "book the train", list: null, priority: null, due: null, due_time: null, recurrence: null, created_by: ACTOR });
    expect(child.ok).toBe(true);
    const post = async (url: string, body: unknown, over: Partial<UiRequest> = {}) => {
      const r = await respond(d, {
        method: "POST", url, host: HOST, origin: `http://${HOST}`, contentType: "application/json", csrfToken: token, body: JSON.stringify(body), ...over,
      });
      return { status: r.status, value: JSON.parse(r.body) as Record<string, unknown> };
    };
    /** Every task row the tests touch, open or done, to check a refusal changed nothing. */
    const snapshot = async () => Promise.all(["tk_parent", "tk_plain", "tk_done", "tk_child", SUB_ID].map((id) => store.getTask(id)));
    return { store, post, snapshot };
  }

  it("edit sets the title and the quick-add words for date, priority and project through the store's updateTask", async () => {
    const s = await tasks();
    const r = await s.post(TASK_EDIT_PATH, { id: "tk_plain", words: "call the bank again tomorrow 10:00 !2 #home" });
    expect(r.status).toBe(200);
    expect(await s.store.getTask("tk_plain")).toMatchObject({ title: "call the bank again", due_date: "2026-11-13", due_time: "10:00", priority: 2, list: "home" });
    expect(r.value.task).toMatchObject({ id: "tk_plain", title: "call the bank again" });
    // Words with no title keep the stored title.
    expect((await s.post(TASK_EDIT_PATH, { id: "tk_plain", words: "!1" })).status).toBe(200);
    expect(await s.store.getTask("tk_plain")).toMatchObject({ title: "call the bank again", priority: 1, list: "home" });
  });

  it("complete sets done_at through the store's completeTask; a second completion writes nothing", async () => {
    const s = await tasks();
    const r = await s.post(TASK_DONE_PATH, { id: "tk_plain" });
    expect(r).toMatchObject({ status: 200, value: { task_id: "tk_plain", completed: true } });
    const done = await s.store.getTask("tk_plain");
    expect(done!.done_at).not.toBeNull();
    expect((await s.post(TASK_DONE_PATH, { id: "tk_plain" })).value).toMatchObject({ completed: false });
    expect(await s.store.getTask("tk_plain")).toEqual(done);
  });

  it("delete removes a task through the store's deleteTask, and a parent once its sub-tasks are done", async () => {
    const s = await tasks();
    expect((await s.post(TASK_DELETE_PATH, { id: "tk_plain" })).status).toBe(200);
    expect(await s.store.getTask("tk_plain")).toBeNull();
    await s.store.completeTask("tk_child");
    expect((await s.post(TASK_DELETE_PATH, { id: "tk_parent" })).status).toBe(200);
    expect(await s.store.getTask("tk_parent")).toBeNull();
  });

  it("add sub-task stores one sub-task under the page's ID through the store's addSubTask; a resend stores no second one", async () => {
    const s = await tasks();
    const body = { parent: "tk_plain", id: SUB_ID, words: "find the card tomorrow !1" };
    const r = await s.post(TASK_SUB_PATH, body);
    expect(r.status).toBe(200);
    expect(await s.store.getTask(SUB_ID)).toMatchObject({ title: "find the card", parent_task_id: "tk_plain", priority: 1, due_date: "2026-11-13", created_by: ACTOR });
    expect((await s.post(TASK_SUB_PATH, body)).status).toBe(200);
    expect((await s.store.listTasks(100)).filter((t) => t.parent_task_id === "tk_plain").map((t) => t.id)).toEqual([SUB_ID]);
  });

  it("each refusal answers 4xx with its reason and leaves the store unchanged", async () => {
    const s = await tasks();
    const before = await s.snapshot();
    const cases: [string, unknown, number, RegExp][] = [
      [TASK_EDIT_PATH, { id: "tk_nope", words: "x" }, 404, /no task tk_nope/],
      [TASK_DONE_PATH, { id: "tk_nope" }, 404, /no task tk_nope/],
      [TASK_DELETE_PATH, { id: "tk_nope" }, 404, /no task tk_nope/],
      [TASK_SUB_PATH, { parent: "tk_nope", id: SUB_ID, words: "x" }, 404, /no task tk_nope/],
      [TASK_DELETE_PATH, { id: "tk_parent" }, 409, /open sub-tasks \(book the train\)/],
      [TASK_SUB_PATH, { parent: "tk_child", id: SUB_ID, words: "deeper" }, 409, /sub-task cannot have sub-tasks/],
      [TASK_EDIT_PATH, { id: "tk_plain", words: "!7" }, 400, /priority must be/],
      [TASK_EDIT_PATH, { id: "tk_plain", words: "" }, 400, /nothing to change/],
      [TASK_EDIT_PATH, { id: "tk_plain", words: "today today" }, 400, /given twice/],
      [TASK_EDIT_PATH, { id: "tk_plain", words: "tomorrow every week" }, 400, /recurrence is not edited here/],
      [TASK_EDIT_PATH, { id: "tk_done", words: "new title" }, 409, /done task cannot be edited/],
      [TASK_SUB_PATH, { parent: "tk_plain", id: SUB_ID, words: "!1 #home" }, 400, /title is empty/],
      [TASK_SUB_PATH, { parent: "tk_plain", id: "bad id", words: "x" }, 400, /id must be tk_/],
      [TASK_DONE_PATH, { id: "tk_plain", extra: 1 }, 400, /unknown field "extra"/],
    ];
    for (const [url, body, status, reason] of cases) {
      const r = await s.post(url, body);
      expect(r.status, `${url} ${JSON.stringify(body)}`).toBe(status);
      expect(String(r.value.error)).toMatch(reason);
    }
    expect(await s.snapshot()).toEqual(before);
  });

  it("each action takes the request guards in order, the CSRF token as quick add does, and writes nothing on a refusal", async () => {
    const s = await tasks();
    const before = await s.snapshot();
    const actions: [string, unknown][] = [
      [TASK_EDIT_PATH, { id: "tk_plain", words: "renamed" }],
      [TASK_DONE_PATH, { id: "tk_plain" }],
      [TASK_DELETE_PATH, { id: "tk_plain" }],
      [TASK_SUB_PATH, { parent: "tk_plain", id: SUB_ID, words: "x" }],
    ];
    for (const [url, body] of actions) {
      expect((await s.post(url, body, { host: "evil.example" })).status, url).toBe(403);
      expect((await s.post(url, body, { origin: "https://evil.example" })).status, url).toBe(403);
      expect((await s.post(url, body, { contentType: "text/plain" })).status, url).toBe(415);
      expect((await s.post(url, body, { csrfToken: undefined })).status, url).toBe(403);
      expect((await s.post(url, body, { csrfToken: "stale" })).status, url).toBe(403);
      expect((await s.post(url, body, { bodyTooLarge: true })).status, url).toBe(413);
    }
    expect(await s.snapshot()).toEqual(before);
  });
});
