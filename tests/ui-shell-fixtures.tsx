import { QueryClient, QueryClientProvider, focusManager } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../web/src/App.js";

export const AT = "2026-11-07T00:00:00.000Z";
export const overview = {
  as_of: AT, stages: { NEW: 1, RUNNING: 2 }, needs_you: 4, running: 1, queued: 1, last_24h: { succeeded: 3, failed: 1, tokens: 1500 },
  unreviewed_merges_7d: 2,
  factory: { state: "migration_pending", rev: "aaaaaaa1111", target_rev: "bbbbbbb2222", child_pid: 7, since: AT, workers: 3, error: null, pending: ["schema 12"] },
};
export const row = (n: number, level: string, title: string, extra: object = {}) => ({
  id: `wi_${n}`, source: { type: "github_issue", id: `o/r#${n}`, link: `https://github.com/o/r/issues/${n}` }, title, item_phase: level, reason_code: "person",
   stage: "RUNNING", tier: 2, kind: null, blocked_on: "none", blocked_reason: null, close_reason: null, run_status: null,
  change_ref: null, change_url: null, since: AT, updated_at: AT, version: 1, dependents: 0, conflicts: { automatic: 0, person: 0 }, ...extra,
});
export const items = {
  as_of: AT, total: 3,
  items: [
    row(1, "needs_approval", "Spec waiting", { stage: "READY", blocked_on: "human" }),
    row(2, "running", "Being built"),
    row(3, "queued", "Waiting its turn"),
  ],
  facets: { allStates: 3, state: { needs: 1, needs_approval: 1, running: 1, queued: 1 } }, counts: { open: 0, running: 1 },
};
export const runs = { as_of: AT, runs: [{ id: "run_a", status: "running", kind: "implement", work_item_id: "wi_2", attempt: 1, owner: "host:7:0", heartbeat_at: AT, started_at: AT, lease_expires_at: AT, created_at: AT }] };
export const queue = { as_of: AT, queue: [{ position: 1, id: "run_b", kind: "implement", work_item_id: "wi_3", attempt: 0, created_at: AT, not_before: null }] };
export const detail = {
  as_of: AT,
  item: { ...row(1, "needs_approval", "Spec waiting"), loop_count: 0, restart_count: 2, token_cost: 2_500_000, created_at: AT, why: { code: "human", reason_code: "person", params: { reason: "Waiting for you" }, alarms: [], holder_id: null, next_actor: "human", refs: [], ref_url: null } },
  timeline: [{ version: 1, at: AT, actor: { kind: "user", id: "github:1" }, reason: "intake", changes: { stage: { from: "null", to: '"NEW"' } }, detail: null }],
  runs: [{ id: "run_c", kind: "implement", status: "failed", attempt: 1, started_at: AT, finished_at: AT, created_at: AT, tokens: 10, error: { code: "git_failed", detail: "git merge: boom" } }],
};
export const RESPONSES: Record<string, unknown> = {
  "/api/v1/overview": overview,
  "/api/v1/items": items,
  "/api/v1/tasks": { today_date: "2026-11-07", today: { overdue: [], due: [] }, upcoming: [], projects: [], csrf_token: "tok", can_build: true, active_projects: [] },
  "/api/v1/runs": runs,
  "/api/v1/queue": queue,
  "/api/v1/workers": { as_of: AT, workers: [{ owner: "host:7:0", running: 1 }] },
  "/api/v1/health": { checked_at: AT, checks: [{ status: "ok", msg: "store reachable" }, { status: "fail", msg: "push access denied" }] },
  "/api/v1/items/wi_1": detail,
  "/api/v1/unreviewed-merges": {
    as_of: AT,
    merges: [
      { project: "github.com/o/r", change_ref: "9", change_url: "https://github.com/o/r/pull/9", merge_sha: "abcdef1", merged_by: "github:7", recorded_at: AT },
      { project: "github.com/o/r", change_ref: "8", change_url: null, merge_sha: "1234567", merged_by: "unknown", recorded_at: AT },
    ],
  },
};

/** The mutable state the tests read: one object, so no file assigns to an imported binding. */
export const state = {
  fetched: [] as string[],
  posts: [] as { url: string; headers: Record<string, string>; body: unknown }[],
  /** The answer to the next command POST. */
  postAnswer: { status: 202, body: { request_id: "app:x", seq: 9, command: "approve", work_item_id: "wi_1" } } as { status: number; body: unknown },
  hidden: false,
};

/** Browser storage for the test: Node 25's own experimental localStorage would otherwise shadow jsdom's. */
class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
}

/** Installs the fetch stub, storage stub and cleanup for one test file: call it once at the top of the file. */
export function installShellFixtures() {
  beforeEach(() => {
    // jsdom has no showModal: open and close by the attribute.
    HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
    HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
    state.fetched = [];
    state.posts = [];
    state.postAnswer = { status: 202, body: { request_id: "app:x", seq: 9, command: "approve", work_item_id: "wi_1" } };
    state.hidden = false;
    vi.stubGlobal("localStorage", new MemoryStorage());
    document.documentElement.classList.remove("dark");
    history.replaceState(null, "", "/app/");
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => (state.hidden ? "hidden" : "visible"));
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      state.fetched.push(url);
      if (init?.method === "POST") {
        state.posts.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify(state.postAnswer.body), { status: state.postAnswer.status, headers: { "content-type": "application/json" } });
      }
      const body = RESPONSES[url.split("?")[0]!];
      if (body === undefined) return new Response(JSON.stringify({ error: "Not found." }), { status: 404 });
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }));
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    cleanup();
    // The send confirmation lives on document.body, outside every rendered tree.
    document.querySelector("[data-toast]")?.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    focusManager.setFocused(undefined);
  });

}

/** Waits for the overview: the sidebar Tasks entry shows the waiting count as its badge. */
export const waitBadge = () => screen.findByRole("link", { name: "Tasks, 4 need you" }).then((a) => expect(a.textContent).toBe("Tasks4"));

export function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
}

export const cmd = (name: string) => ({ name, usage: `/${name}`, description: `${name} it`, allowed: true, reason: null as string | null });
export const SESSION = { as_of: AT, csrf_token: "tok-123", commands_enabled: true, actor: "local:me", actor_source: "environment" as const };

export const cap = (name: string) => name[0]!.toUpperCase() + name.slice(1);
/** The element whose `data-action` is `name` (a Needs-you row's hidden shortcut button while its menu is shut). */
export const rowOf = (name: string) => document.querySelector(`[data-action="${name}"]`) as HTMLElement;
export const settle = () => act(async () => void (await vi.advanceTimersByTimeAsync(10)));
export const button = (name: string) => screen.getByRole("button", { name: cap(name) }) as HTMLButtonElement;

// The item page fixtures (tests/item-page*.test.tsx): the builders, the detail items, the fetch stub and the mount.

export const src = (n: number) => ({ type: "github_issue", id: `o/r#${n}`, link: `https://github.com/o/r/issues/${n}` });
export const base = (id: string, n: number, title: string, extra: object = {}) => ({
  id, source: src(n), title, stage: "READY", close_reason: null, blocked_on: "human", blocked_reason: "spec_pending", tier: 2, loop_count: 0,
  restart_count: 0, token_cost: 0, change_ref: null, change_url: null, spec_comment_url: null, parent_id: null, phase: null, phases: [], version: 3,
  created_at: AT, updated_at: AT, why: { code: "human", reason_code: "person", params: { reason: "Waiting for a person" }, alarms: [], holder_id: null, next_actor: "human", refs: [], ref_url: null }, ...extra,
});

// A fixture spec as triage writes it: a heading, a blank line, a list, and text that must not become HTML.
export const PROBLEM = "## Problem\n\nThe page prints `JSON`.\n\nSecond paragraph with <b>raw html</b>.";
export const DONE = ["Phases link to their pages", "No escaped JSON"];
export const FILES = ["web/src/views/pages.tsx", "src/ui/api.ts"];

export const DETAILS: Record<string, unknown> = {
  "/api/v1/items/wi_parent": {
    as_of: AT,
    item: base("wi_parent", 10, "Split parent", {
      spec_comment_url: "https://github.com/o/r/issues/10#issuecomment-5",
      change_ref: "12",
      change_url: "https://github.com/o/r/pull/12",
      phases: [
        { id: "wi_p1", phase: 1, title: "First phase", stage: "RUNNING", source: src(11) },
        { id: "wi_p2", phase: 2, title: null, stage: "NEW", source: src(13) },
      ],
    }),
    timeline: [
      { version: 1, at: AT, actor: { kind: "system", id: "system" }, reason: "intake", changes: { stage: { from: "null", to: '"NEW"' } }, detail: null },
      {
        version: 2, at: AT, actor: { kind: "system", id: "system" }, reason: "triaged", detail: null,
        changes: {
          stage: { from: '"NEW"', to: '"READY"' },
          problem: { from: JSON.stringify("issue text"), to: JSON.stringify(PROBLEM) },
          done_criteria: { from: "null", to: JSON.stringify(DONE) },
          files_to_change: { from: "null", to: JSON.stringify(FILES) },
          scope: { from: "null", to: JSON.stringify("In scope: the item page.") },
        },
      },
    ],
    runs: [{ id: "run_triage_1", kind: "triage", status: "succeeded", attempt: 2, started_at: AT, finished_at: AT, created_at: AT, tokens: 10, error: null }],
  },
  "/api/v1/items/wi_live": {
    as_of: AT,
    item: base("wi_live", 20, "Live interactive"),
    timeline: [],
    runs: [{ id: "run_i_1", kind: "interactive", status: "running", attempt: 1, started_at: AT, finished_at: null, created_at: AT, tokens: 0, error: null }],
  },
  "/api/v1/items/wi_done": {
    as_of: AT,
    item: base("wi_done", 21, "Finished interactive"),
    timeline: [],
    runs: [{ id: "run_i_2", kind: "interactive", status: "succeeded", attempt: 1, started_at: AT, finished_at: AT, created_at: AT, tokens: 0, error: null }],
  },
  "/api/v1/items/wi_closed": {
    as_of: AT,
    item: base("wi_closed", 40, "Rejected plan", {
      stage: "CLOSED", close_reason: "rejected", blocked_on: "none", blocked_reason: null, tier: null, item_phase: "rejected", restart_count: 0, loop_count: 0,
      why: { code: "closed", reason_code: "closed_as", params: { reason: "rejected" }, alarms: [], holder_id: null, next_actor: "none", refs: [], ref_url: null },
    }),
    timeline: [
      { version: 1, at: AT, actor: { kind: "system", id: "system" }, reason: "intake", changes: { stage: { from: "null", to: '"NEW"' } }, detail: null },
      { version: 2, at: AT, actor: { kind: "user", id: "local:someone" }, reason: "spec_rejected", changes: { stage: { from: '"READY"', to: '"CLOSED"' } }, detail: null },
    ],
    thread: [{ seq: 7, at: AT, kind: "command", author: "local:someone", role: "owner", channel: "local", anchor: "msg-7", body: "/reject out of scope" }],
    commands: [],
    runs: [],
  },
  "/api/v1/items/wi_about": {
    as_of: AT,
    item: base("wi_about", 30, "About spec", {
      request: "Item page shows what the work is about",
      spec: { problem: "The page shows no text about the work.", desired_output: "[withheld: github_token]", done_criteria: ["About shows the summary", "[withheld: github_token]", "Spec starts collapsed"] },
    }),
    timeline: [],
    runs: [],
  },
  "/api/v1/items/wi_request": {
    as_of: AT,
    item: base("wi_request", 31, "Request only", { request: "Only the request so far", spec: null }),
    timeline: [],
    runs: [],
  },
  "/api/v1/items/wi_withheld": {
    as_of: AT,
    item: base("wi_withheld", 32, "Flagged request", { request: "[withheld: github_token]", spec: null }),
    timeline: [],
    runs: [],
  },
  "/api/v1/items/wi_p1": {
    as_of: AT,
    item: base("wi_p1", 11, "First phase", { parent_id: "wi_parent", phase: 1, spec_comment_url: "[withheld: github_token]", change_ref: "14", change_url: "javascript:alert(1)" }),
    timeline: [],
    runs: [],
  },
};

/** Installs the item page's fetch stub and cleanup for one test file: call it once at the top of the file. */
export function installItemPageFixtures() {
  beforeEach(() => {
    history.replaceState(null, "", "/app/");
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const path = url.split("?")[0]!;
      const body = DETAILS[path] ?? (path === "/api/v1/overview" ? { as_of: AT, stages: {}, needs_you: 0, running: 0, queued: 0, last_24h: { succeeded: 0, failed: 0, tokens: 0 } } : undefined);
      if (body === undefined) return new Response(JSON.stringify({ error: "Not found." }), { status: 404 });
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }));
    vi.stubGlobal("scrollTo", () => undefined);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });
}

/** The element at `selector`, once the page shows it. */
export const found = (selector: string) =>
  waitFor(() => {
    const el = document.querySelector<HTMLElement>(selector);
    if (!el) throw new Error(`no ${selector} yet`);
    return el;
  });

export function mountItem(path: string) {
  history.replaceState(null, "", path);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
}

/** Installs jsdom's missing dialog methods for one test file: call it once at the top of a file that opens dialogs. */
export function installDialogStub() {
  beforeEach(() => {
    // jsdom has no showModal: open and close by the attribute.
    HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
    HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  });
}


// The item page's DecisionCard setup (design 09-dashboard-item-commands), shared by the decide test files.
export const DECIDE_AT = "2026-11-12T00:00:00.000Z";
export const decideCmd = (name: string) => ({ name, usage: `/${name}`, description: name, allowed: true, reason: null });
export const SPEC = {
  in_short: "AS-IS: nothing checks the scope.\nTO-BE: CI checks the scope.",
  decisions: [
    { question: "Fail the job, or only warn?", options: ["Fail the job", "Only warn"], default: "Fail the job", reason: "A failing job blocks merges.", owner_only: false },
    { question: "Name the step?", options: [], default: "scope", reason: null, owner_only: false },
  ],
};
export const item = (extra: object = {}) => ({
  id: "wi_9f3c2a", source: { type: "github_issue", id: "o/r#30", link: "https://github.com/o/r/issues/30" }, title: "Check the scope in CI",
  stage: "READY", close_reason: null, blocked_on: "human", blocked_reason: "spec_pending", tier: 2, loop_count: 0, restart_count: 0, token_cost: 0,
  change_ref: null, change_url: null, spec_comment_url: null, parent_id: null, phase: null, phases: [], version: 3, created_at: DECIDE_AT, updated_at: DECIDE_AT,
  why: { code: "human", reason_code: "spec_pending", params: {}, alarms: [], holder_id: null, next_actor: "human", refs: [], ref_url: null },
  ...extra,
});
export const decideDetail = (extra: object = {}) => ({
  as_of: DECIDE_AT,
  item: item(),
  timeline: [
    { version: 1, at: DECIDE_AT, actor: { kind: "user", id: "local:me" }, reason: "intake", changes: {}, detail: null },
    { version: 2, at: DECIDE_AT, actor: { kind: "user", id: "github:4711", name: null }, reason: "retry_requested", changes: {}, detail: null },
  ],
  runs: [{ id: "run_t1", kind: "triage", status: "succeeded", attempt: 1, started_at: DECIDE_AT, finished_at: DECIDE_AT, created_at: DECIDE_AT, tokens: 5, error: null, attempts: [{ attempt: 1, worker_id: "mac-mini:4242:3" }] }],
  commands: ["approve", "revise", "reject"].map(decideCmd),
  replies: [],
  spec: SPEC,
  ...extra,
});

/** The mutable state of the DecisionCard tests: one object, so no file assigns to an imported binding. */
export const decideState = {
  body: {} as Record<string, unknown>,
  /** The commands POSTs the page sent, with their JSON bodies. */
  posts: [] as { url: string; body: unknown }[],
};

/** Registers the beforeEach (fetch and scrollTo stubs, history path) and afterEach (cleanup, unstub) of the DecisionCard tests. */
export function installDecideFixtures() {
  beforeEach(() => {
    decideState.body = decideDetail();
    decideState.posts = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.split("?")[0]!;
      if (init?.method === "POST") {
        decideState.posts.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ request_id: "app:1", seq: 1, command: "x", work_item_id: "wi_9f3c2a" }), { status: 202, headers: { "content-type": "application/json" } });
      }
      const bodies: Record<string, unknown> = {
        "/api/v1/items/wi_9f3c2a": decideState.body,
        "/api/v1/session": { as_of: DECIDE_AT, csrf_token: "tok", commands_enabled: true, actor: "local:me", actor_source: "environment" },
        "/api/v1/overview": { as_of: DECIDE_AT, stages: {}, needs_you: 1, running: 0, queued: 0, last_24h: { succeeded: 0, failed: 0, tokens: 0 } },
      };
      const out = bodies[path];
      if (out === undefined) return new Response(JSON.stringify({ error: "Not found." }), { status: 404 });
      return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
    }));
    vi.stubGlobal("scrollTo", () => undefined);
    history.replaceState(null, "", "/app/items/wi_9f3c2a");
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });
}

export function mountDecide() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><App /></QueryClientProvider>);
}

/** The card, once the session has enabled its buttons. */
export async function box() {
  const decide = await screen.findByRole("region", { name: "What you need to decide" });
  await vi.waitFor(() => expect((within(decide).getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(false));
  return decide;
}

export const FACTORY_MSG = { seq: 7, at: DECIDE_AT, kind: "spec", author: "factory", role: "factory", channel: "github_issue", anchor: "msg-7", body: "## Spec ready for approval\n\nLonger text of the spec." };
