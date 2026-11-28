// Shared setup for the ui-api test files (tests/ui-api*.test.ts): one seeded store and the helpers that read it.
// The auto-stop dashboard tests (tests/auto-stop-*.test.ts) share the fetch stub and view builders at the bottom.

/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { type FunctionComponent, type ReactElement, createElement } from "react";
import { expect, vi } from "vitest";
import type { AutoStop, SettingRow, SettingsView, SystemAction } from "../web/src/api.js";
import type { WorkItem, WorkerId } from "../src/core/types.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { HealthMonitor } from "../src/ui/health.js";
import type { UiDeps, UiResponse } from "../src/ui/server.js";
import { issue, newStore, system, w1 } from "./helpers/store.js";

export const LEASE = 60_000;
// Built here so no secret-shaped literal sits in the repository.
export const SECRET = `ghp_${"Ab3".repeat(12)}`;
export const ROUTES = [
  "/api/v1/overview", "/api/v1/items", "/api/v1/items/ITEM", "/api/v1/runs", "/api/v1/queue", "/api/v1/workers", "/api/v1/health", "/api/v1/unreviewed-merges",
  "/api/v1/data/tables", "/api/v1/data/tables/controller_work_items", "/api/v1/data/tables/worker_runs", "/api/v1/data/tables/controller_state_changes",
];

// The server module is loaded when first used: it reads import.meta.url as a file URL, which the jsdom auto-stop tests
// that share this file do not have.
export async function get(d: UiDeps, path: string, opts: { method?: string; host?: string } = {}): Promise<UiResponse> {
  const { respond } = await import("../src/ui/server.js");
  return respond(d, { method: opts.method ?? "GET", url: path, host: opts.host ?? "127.0.0.1:4310" });
}

export async function json<T = Record<string, unknown>>(d: UiDeps, path: string): Promise<T> {
  const r = await get(d, path);
  expect(r.status, path).toBe(200);
  return JSON.parse(r.body) as T;
}

export async function make(store: FactoryStore, n: number, title: string | null): Promise<WorkItem> {
  return (await store.createWorkItem({ ...issue(n), ...(title === null ? {} : { title }) }, system)).item;
}

export async function patch(store: FactoryStore, item: WorkItem, p: Parameters<FactoryStore["transition"]>[0]["patch"], reason = "seed") {
  const cur = (await store.getWorkItem(item.id))!;
  const r = await store.transition({ id: item.id, expected_version: cur.version, patch: p, actor: system, reason });
  if (!r.ok) throw new Error(r.reason);
  return r.item;
}

export async function enqueue(store: FactoryStore, item: WorkItem, kind: "triage" | "implement" | "review", key: string, p: Parameters<FactoryStore["transition"]>[0]["patch"] = {}) {
  const cur = (await store.getWorkItem(item.id))!;
  const r = await store.transition({ id: item.id, expected_version: cur.version, patch: p, actor: system, reason: "x", enqueue: { kind, idempotency_key: key } });
  if (!r.ok) throw new Error(r.reason);
}

/** One item per level, finished runs in the last 24 h, two running runs on two workers, and a secret in every free-text field. */
export async function seeded(opts: { store?: (s: FactoryStore) => FactoryStore } = {}) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);

  const approve = await make(store, 1, "Spec for <script>alert(1)</script> the gate");
  await patch(store, approve, { stage: "READY", blocked_on: "human", blocked_reason: "spec_pending" });
  const merge = await make(store, 2, "Merge me");
  await patch(store, merge, { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", change_ref: "42", tier: 2 });
  // Secrets: a title, a blocked reason, a state-change reason and detail value.
  const secretive = await make(store, 3, `Leaky ${SECRET} title`);
  await patch(store, secretive, { blocked_on: "human", blocked_reason: `custom ${SECRET}` }, `reason ${SECRET}`);
  const cur = (await store.getWorkItem(secretive.id))!;
  await store.transition({ id: secretive.id, expected_version: cur.version, patch: { tier: 3 }, actor: system, reason: "x", detail: { note: `detail ${SECRET}` } });

  // Finished runs: one succeeded with tokens, one failed carrying a secret in its error detail.
  const done = await make(store, 4, "Done item");
  await enqueue(store, done, "triage", "done:t");
  let r = (await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: LEASE }))!;
  clock.advance(90_000);
  await store.completeRun(r.id, r.lease!.token, { status: "succeeded", summary: "ok", data: { tokens: 1234 } });
  await enqueue(store, done, "implement", "done:i");
  r = (await store.claimRun({ worker_id: w1, kinds: ["implement"], lease_ms: LEASE }))!;
  await store.completeRun(r.id, r.lease!.token, { status: "failed", error_code: "agent_error", detail: `push failed: token ${SECRET} rejected`, infra: false });
  await patch(store, done, { stage: "CLOSED", close_reason: "completed", token_cost: 1234 });

  // Running: one on a plain worker (heartbeat goes stale), one on a worker whose id carries a secret.
  const running = await make(store, 5, "Running item");
  await enqueue(store, running, "implement", "run:i", { stage: "RUNNING" });
  const claimed = (await store.claimRun({ worker_id: "host:11:1" as WorkerId, kinds: ["implement"], lease_ms: LEASE }))!;
  const running2 = await make(store, 6, "Second running item");
  await enqueue(store, running2, "review", "run:r", { stage: "REVIEW" });
  const claimed2 = (await store.claimRun({ worker_id: `host:${SECRET}:2` as WorkerId, kinds: ["review"], lease_ms: LEASE }))!;
  const running3 = await make(store, 7, "Third running item");
  await enqueue(store, running3, "implement", "run:i3", { stage: "RUNNING" });
  await store.claimRun({ worker_id: "host:11:1" as WorkerId, kinds: ["implement"], lease_ms: LEASE });

  // Queued, one without a title.
  const queued = await make(store, 8, null);
  await enqueue(store, queued, "triage", "q:t");
  const queued2 = await make(store, 9, "Queued two");
  clock.advance(1_000);
  await enqueue(store, queued2, "triage", "q:t2");

  clock.advance(LEASE + 5_000);

  const scanner = new PatternEgressScanner(async () => []);
  let healthRuns = 0;
  const health = new HealthMonitor(async () => {
    healthRuns++;
    return [{ ok: true, msg: "secret file is outside the repository" }, { ok: false, msg: `mysql said ${SECRET}` }];
  }, clock);
  const d: UiDeps = {
    store: opts.store ? opts.store(store) : store,
    scanner,
    clock,
    lease_ms: LEASE,
    health,
  };
  return { d, store, clock, items: { approve, merge, secretive, done, running, running2, running3, queued, queued2 }, claimed, claimed2, healthRuns: () => healthRuns };
}

// The last auto-mode stop (design 03-risk), shown beside the Mode toggle (with its link to the alarm and its button)
// and on its alarm's Needs-you row (the Check group, design 09-dashboard-tasks): one sentence in local time, the
// server's full text behind a Details toggle, and a "⋯" menu of Turn auto back on (the same settings write) and What
// failed. Turn auto back on opens the mode confirmation Dialog (design 09-dashboard-settings, 2026-11-22); only its
// Confirm writes. A burst of agent-run failures stops nothing, so there is no stop: its alarm's row has Show failures.


// tsconfig.test.json checks this file without JSX, so the views are built with createElement and their .tsx modules are
// loaded by a specifier the node check skips (as in ui-settings-page.test.tsx). Loaded lazily, so the other tests that
// share this file never load them: an auto-stop test file calls loadViews() in its beforeEach.
const SETTINGS_MODULE = "../web/src/views/settings.js";
const BANNER_MODULE = "../web/src/views/system-banner.js";
let SettingsPage: FunctionComponent;
let CheckRow: FunctionComponent<{ action: SystemAction }>;
export async function loadViews(): Promise<void> {
  SettingsPage = ((await import(/* @vite-ignore */ SETTINGS_MODULE)) as { SettingsPage: FunctionComponent }).SettingsPage;
  CheckRow = ((await import(/* @vite-ignore */ BANNER_MODULE)) as { CheckRow: FunctionComponent<{ action: SystemAction }> }).CheckRow;
}

/** The items of a row's ⋯ menu as [label, data-action]; the menu is closed again after reading. */
export function menuOf(row: HTMLElement): [string | null, string | null][] {
  const more = within(row).getByRole("button", { name: "More commands" });
  fireEvent.click(more);
  const items = within(row).getAllByRole("menuitem").map((m) => [m.textContent, m.getAttribute("data-action")] as [string | null, string | null]);
  fireEvent.click(more);
  return items;
}

/** The Check group's rows of `actions`, as NeedsList draws them. */
export const checks = (actions: readonly SystemAction[]) => createElement("ul", null, actions.map((action, i) => createElement(CheckRow, { key: i, action })));

export const AT = "2026-11-13T11:52:30.000Z";
export const TOKEN = "tok_stop";
export const row = (key: string, extra: Partial<SettingRow>): SettingRow => ({
  key, description: key, kind: "number", value: "0", source: "default", file_value: null, default_value: "0", applies_at: "the next tick",
  project_settable: false, projects: [], ...extra,
});
export const settingsView = (mode: "auto" | "manual", auto_stop: AutoStop | null): SettingsView => ({
  as_of: AT,
  csrf_token: TOKEN,
  repo: "o/r",
  project: null,
  project_keys: [],
  keys: [
    row("mode", { kind: "mode", value: JSON.stringify(mode), source: "override", default_value: '"manual"', project_settable: true }),
    row("auto_merge_max_tier", {}),
  ],
  pr_only: [],
  file_keys: null,
  ignored: [],
  history: [],
  auto_stop,
});
export const stop = (cause: string): AutoStop => ({ alert_id: "al_1", at: AT, cause });
export const time = new Date(AT).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
/** The server's full text of an auto-stop alarm (alarmText and its detail). */
export const FULL = "Alarm: back to manual: the checks failed on the base branch after a merge: `npm test` exited 1 on the new tip of `main`";
export const alarm = (auto_stop?: AutoStop): SystemAction => ({
  code: "alarm", text: "Alarm: something", command: "factory doctor", until: null, ...(auto_stop ? { auto_stop } : {}),
});

/** The state the fetch stub reads and records: the settings view it serves and the writes it saw. */
export const stub: { view: SettingsView; posts: { url: string; init: RequestInit }[] } = { view: settingsView("manual", null), posts: [] };

/** Resets the stub and stubs fetch with it; call it in a test file's beforeEach. */
export async function installFetch(): Promise<void> {
  await loadViews();
  stub.posts = [];
  stub.view = settingsView("manual", null);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (init?.method === "POST") {
      stub.posts.push({ url, init });
      return json({ ok: true, lines: ["mode = \"auto\""] });
    }
    if (url === "/api/v1/settings") return json(stub.view);
    if (url === "/api/v1/session") return json({ as_of: AT, csrf_token: "t", commands_enabled: true, actor: "local:me", actor_source: "environment" });
    return new Response("{}", { status: 404 });
  }));
}


export function mount(el: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(createElement(QueryClientProvider, { client }, el));
}

/** The Settings page's Mode section, once loaded. */
export async function modeSection(): Promise<HTMLElement> {
  mount(createElement(SettingsPage));
  return screen.findByRole("region", { name: "Mode" });
}

/** The open mode confirmation Dialog. */
export const modeDialog = () => screen.getByRole("dialog", { name: "Turn on auto mode?" });

/** Confirms the open mode Dialog and returns the one write it posted; nothing was posted before Confirm. */
export async function confirmAuto() {
  expect(stub.posts).toHaveLength(0);
  await act(async () => fireEvent.click(within(modeDialog()).getByRole("button", { name: "Turn on auto" })));
  expect(stub.posts).toHaveLength(1);
  expect(stub.posts[0]!.url).toBe("/api/v1/settings");
  expect((stub.posts[0]!.init.headers as Record<string, string>)["x-csrf-token"]).toBe(TOKEN);
  return JSON.parse(String(stub.posts[0]!.init.body)) as unknown;
}

/** Clicks "Turn auto back on" in `scope`, which opens the Dialog, and confirms it; returns the write it posted. */
export async function turnAutoOn(scope: HTMLElement) {
  const button = await within(scope).findByRole("button", { name: "Turn auto back on" });
  await act(async () => fireEvent.click(button));
  return confirmAuto();
}

/** The local-time sentence of an auto-stop row. */
export const sentence = (cause: string) => `Auto mode stopped at ${time}: ${cause}`;
