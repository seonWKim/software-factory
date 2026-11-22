import { QueryClient, QueryClientProvider, focusManager } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
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
export const rowOf = (name: string) => document.querySelector(`[data-command="${name}"]`) as HTMLElement;
export const settle = () => act(async () => void (await vi.advanceTimersByTimeAsync(10)));
export const button = (name: string) => screen.getByRole("button", { name: cap(name) }) as HTMLButtonElement;
