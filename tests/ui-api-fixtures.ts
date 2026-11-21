// Shared setup for the ui-api test files (tests/ui-api*.test.ts): one seeded store and the helpers that read it.

import { expect } from "vitest";
import type { WorkItem, WorkerId } from "../src/core/types.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { HealthMonitor } from "../src/ui/health.js";
import { type UiDeps, type UiResponse, respond } from "../src/ui/server.js";
import { issue, newStore, system, w1 } from "./helpers/store.js";

export const LEASE = 60_000;
// Built here so no secret-shaped literal sits in the repository.
export const SECRET = `ghp_${"Ab3".repeat(12)}`;
export const ROUTES = [
  "/api/v1/overview", "/api/v1/items", "/api/v1/items/ITEM", "/api/v1/runs", "/api/v1/queue", "/api/v1/workers", "/api/v1/health", "/api/v1/unreviewed-merges",
  "/api/v1/data/tables", "/api/v1/data/tables/controller_work_items", "/api/v1/data/tables/worker_runs", "/api/v1/data/tables/controller_state_changes",
];

export function get(d: UiDeps, path: string, opts: { method?: string; host?: string } = {}): Promise<UiResponse> {
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
