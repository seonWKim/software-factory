// @ts-nocheck -- tsconfig.test.json has no DOM or JSX; like the other ui tests this file typechecks under the web config.
// Node environment: the store (node:sqlite) cannot load under jsdom, so the page renders here to static markup and
// its click behaviour is in tests/activity.test.ts.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { DECLARATIONS, REGISTRY } from "../src/api/index.js";
import { BACKGROUND_JOBS } from "../src/controller/background-jobs.js";
import { ALERT_DEDUPE_MS } from "../src/core/alarms.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { ACTIVITY_RETENTION_DAYS } from "../src/impl/store/sql/activity.js";
import { ACTOR_WORDS, readActivity } from "../src/ui/activity-api.js";
import { ActivityBody } from "../web/src/views/activity/page.js";
import { newStore } from "./helpers/store.js";

// The Activity read (design 09-dashboard-activity): one entry per autonomous actor, its recent actions with outcome,
// reason and a Transcript or log link, none older than the retention days; the capability that serves it; the page.

const ROOT = join(import.meta.dirname, "..");
const DAY = 86_400_000;
const T0 = "2026-11-26T10:00:00.000Z";
const TRANSCRIPT = "/api/v1/items/wi_1/runs/run_1/transcript";

describe("the Activity read", () => {
  it("lists every background job as an actor with its name, now, last and next run and recent actions", async () => {
    const { store, clock } = await newStore(new FakeClock(T0));
    await store.recordActivity({ actor_id: "system:cleanup", kind: "cleanup", subject: "cleanup:h1", outcome: "removed", reason: "unused", ref: "log:controller:cleanup sweep" });
    const v = await readActivity({ store, clock });
    expect(v.actors.map((a) => a.actor_id)).toEqual(BACKGROUND_JOBS.map((j) => j.actor_id));
    for (const a of v.actors) expect(a).toMatchObject({ name: expect.any(String), now: expect.any(String), about: expect.any(String) });
    const cleanup = v.actors.find((a) => a.actor_id === "system:cleanup");
    expect(cleanup).toMatchObject({ name: ACTOR_WORDS.cleanup.name, last_at: T0, actions: [{ outcome: "removed", reason: "unused" }] });
    expect(v.actors.find((a) => a.actor_id === "system:reaper")).toMatchObject({ last_at: null, next_run_at: null, actions: [] });
  });

  it("gives each recent action its outcome, reason and a Transcript or log link", async () => {
    const { store, clock } = await newStore(new FakeClock(T0));
    await store.recordActivity({ actor_id: "system:schedule", kind: "schedule_run", subject: "s1", outcome: "started", reason: "due", ref: TRANSCRIPT });
    await store.recordActivity({ actor_id: "system:schedule", kind: "schedule_run", subject: "s2", outcome: "failed", reason: "no slot", ref: "log:controller:schedule skipped" });
    const schedule = (await readActivity({ store, clock })).actors.find((a) => a.actor_id === "system:schedule");
    const [log, run] = schedule.actions;
    expect(run).toMatchObject({ outcome: "started", reason: "due", link: { kind: "transcript", href: "/app/items/wi_1/runs/run_1" } });
    expect(log).toMatchObject({ outcome: "failed", reason: "no slot", link: { kind: "log", href: null, text: "controller: schedule skipped" } });
    expect(schedule.state).toBe("attention");
  });

  it("returns no entry older than 30 days", async () => {
    expect(ACTIVITY_RETENTION_DAYS).toBe(30);
    const { store, clock } = await newStore(new FakeClock(T0));
    await store.recordActivity({ actor_id: "system:cleanup", kind: "cleanup", subject: "old", outcome: "removed", reason: "unused", ref: null });
    clock.advance(31 * DAY);
    await store.recordActivity({ actor_id: "system:cleanup", kind: "cleanup", subject: "new", outcome: "removed", reason: "unused", ref: null });
    const v = await readActivity({ store, clock });
    expect(v.retention_days).toBe(30);
    expect(v.actors.find((a) => a.actor_id === "system:cleanup").actions.map((a) => a.subject)).toEqual(["new"]);
  });

  it("drops a dismissed factory alert from the read, and keeps an open one", async () => {
    const { store, clock } = await newStore(new FakeClock(T0));
    const r = await store.recordAlert({ pattern: "zero_tokens", pattern_key: "zero_tokens", error_code: "zero_tokens", count: 3, detail: null }, ALERT_DEDUPE_MS);
    const open = await readActivity({ store, clock });
    expect(open.alerts).toHaveLength(1);
    clock.advance(1000);
    await store.dismissAlert(r.alert.id, "owner");
    expect((await readActivity({ store, clock })).alerts).toEqual([]);
  });
});

describe("the Activity capability", () => {
  it("is declared once in capabilities/activity.ts, listed in index.ts, and called through the generated client by the page", () => {
    const declared = DECLARATIONS.filter((d) => d.id === "activity.actors");
    expect(declared).toHaveLength(1);
    expect(declared[0]).toMatchObject({ method: "GET", path: "/api/v1/activity", permission: "read" });
    expect(REGISTRY.capabilities.map((c) => c.id)).toContain("activity.actors");
    expect(readFileSync(join(ROOT, "src/api/index.ts"), "utf8")).toContain("capabilities/activity.js");
    expect(readFileSync(join(ROOT, "web/src/api/generated.ts"), "utf8")).toContain('export const activityActors');
    expect(readFileSync(join(ROOT, "web/src/api/activity.ts"), "utf8")).toContain("activityActors");
    expect(readFileSync(join(ROOT, "src/api/capabilities/activity.ts"), "utf8")).toContain("readActivity");
    for (const f of ["web/src/api/activity.ts", "web/src/views/activity/page.tsx"]) expect(readFileSync(join(ROOT, f), "utf8")).not.toMatch(/fetch\(\s*["'`]\/api\/v1\/activity/);
  });
});

const VIEW = {
  as_of: T0, retention_days: 30,
  actors: [
    { actor_id: "system:schedule", name: "Schedules", about: "Starts work.", state: "attention", now: "Waiting", last_at: T0, next_run_at: null, transcript: { kind: "transcript", href: "/app/items/wi_1/runs/run_1", text: TRANSCRIPT },
      actions: [{ seq: 1, kind: "schedule_run", subject: "s1", outcome: "failed", reason: "no slot", at: T0, link: { kind: "transcript", href: "/app/items/wi_1/runs/run_1", text: TRANSCRIPT } }] },
    { actor_id: "system:cleanup", name: "Workspace cleanup", about: "Cleans.", state: "idle", now: "Waiting", last_at: null, next_run_at: null, transcript: null, actions: [] },
  ],
  alerts: [{ alert_id: "al_1", text: "Zero tokens", created_at: T0 }],
};

describe("the Activity page", () => {
  it("clears a factory alert with a Dismiss button labelled Clear", () => {
    const client = new QueryClient();
    client.setQueryData(["/api/v1/session"], { csrf_token: "tok" });
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(ActivityBody, { view: VIEW, now: Date.parse(T0) })));
    expect(html).toMatch(/<button[^>]*aria-label="Clear alert[^"]*"[^>]*>Clear<\/button>/);
  });
});
