import { describe, expect, it } from "vitest";
import type { WorkerId } from "../../src/core/types.js";
import { HealthMonitor } from "../../src/ui/health.js";
import { parseFilters } from "../../src/ui/filters.js";
import { renderIndex } from "../../src/ui/pages.js";
import { type PriorityInput, badgesOf, levelOf } from "../../src/ui/priority.js";
import { cleanScanner } from "../helpers/fakes.js";
import { issue, newStore, system } from "../helpers/store.js";

// Design §5 Pause: the dashboard shows a paused run as paused, with its paused_at and the paused-by ID, and never
// as stuck, however long it waits. Rendered without a server (the page function itself).

const LEASE = 60_000;
const BY = "github:42";

function section(body: string, id: string): string {
  const start = body.indexOf(`<section id="${id}">`);
  if (start < 0) throw new Error(`no section ${id}`);
  return body.slice(start, body.indexOf("</section>", start));
}

describe("dashboard: paused runs", () => {
  it("a paused run is listed as paused with paused_at and the paused-by ID; its item is never stuck", async () => {
    const { store, clock } = await newStore();
    const { item } = await store.createWorkItem({ ...issue(1), title: "Pause me" }, system, {
      enqueue: { kind: "implement", idempotency_key: "i" },
    });
    await store.transition({ id: item.id, expected_version: item.version, patch: { stage: "RUNNING" }, actor: system, reason: "seed" });
    const worker = "hostA:1:0" as WorkerId;
    const run = (await store.claimRun({ worker_id: worker, kinds: ["implement"], lease_ms: LEASE }))!;
    await store.pauseWorkers({ count: 1 }, BY);
    const resume = { host: "hostA", folder: "sbx_1", base_sha: null, start_sha: "a", head: "b", bundle: null };
    await store.pauseRun(run.id, run.lease!.token, { paused_by: BY, session_id: null, resume });
    const paused = (await store.getRun(run.id))!;
    // Long past any lease: a running run this old would be stuck.
    clock.advance(10 * LEASE);

    const deps = {
      store, scanner: cleanScanner, clock, lease_ms: LEASE,
      health: new HealthMonitor(async () => [], clock),
    };
    const parsed = parseFilters(new URLSearchParams());
    if (!parsed.ok) throw new Error(parsed.error);
    const body = await renderIndex(deps, parsed.filters);

    const p = section(body, "paused");
    expect(p).toContain("Pause me");
    expect(p).toContain(paused.paused_at!);
    expect(p).toContain(BY);
    expect(p).toContain("implement");
    expect(p).toContain(worker);
    expect(p).toContain("factory workers resume");
    expect(section(body, "queue")).toContain("(paused)");
    const items = section(body, "items");
    expect(items).toContain("paused implement");
    expect(items).not.toMatch(/stuck/i);

    // Resumed: no longer paused anywhere on the page.
    await store.resumeWorkers();
    await store.claimRun({ worker_id: worker, kinds: ["implement"], lease_ms: LEASE });
    const after = await renderIndex(deps, parsed.filters);
    expect(section(after, "paused")).toContain("no paused runs");
    expect(section(after, "paused")).toContain("No worker is paused");
  });

  it("ranking: a paused queued run is queued with a `paused` badge, never stuck", () => {
    const now = new Date("2026-11-01T12:00:00.000Z");
    const input: PriorityInput = {
      stage: "RUNNING", blocked_on: "none", blocked_reason: null, close_reason: null, tier: 2,
      since: "2026-10-01T00:00:00.000Z", dependents: 0, waiting_on: 0,
      run: { kind: "review", status: "queued", heartbeat_at: "2026-10-01T00:00:00.000Z", paused_at: "2026-10-01T00:00:00.000Z" },
    };
    expect(levelOf(input, now, LEASE)).toBe("queued");
    expect(badgesOf(input, "queued", now, LEASE)).toEqual(["paused review"]);
  });
});
