import { describe, expect, it } from "vitest";
import { autoResolveKey } from "../../src/core/policy.js";
import type { WorkItem } from "../../src/core/types.js";
import { FakeClock } from "../../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../../src/impl/egress/pattern-egress-scanner.js";
import type { FactoryStore } from "../../src/interfaces/factory-store.js";
import { NO_FILTERS } from "../../src/ui/filters.js";
import { HealthMonitor } from "../../src/ui/health.js";
import { type UiDeps, renderIndex, renderItem } from "../../src/ui/pages.js";
import { issue, newStore, system, w1 } from "../helpers/store.js";

// The dashboard shows each item's merge-conflict counts (design §5 Merge conflict, decided 2026-11-02):
// resolved automatically, and needed a person. Rendered without a server, so no port is opened.

const LEASE = 60_000;

function deps(store: FactoryStore, clock: FakeClock): UiDeps {
  return {
    store,
    scanner: new PatternEgressScanner(async () => []),
    clock,
    lease_ms: LEASE,
    prUrl: (label, n) => `https://${label}/pull/${n}`,
    health: new HealthMonitor(async () => [{ ok: true, msg: "ok" }], clock),
  };
}

/** One run of `kind` under `key`, claimed and completed with `data` (succeeded) or failed. */
async function runOnce(store: FactoryStore, item: WorkItem, kind: "resolve" | "implement", key: string, data: Record<string, unknown> | null) {
  const cur = (await store.getWorkItem(item.id))!;
  const t = await store.transition({ id: item.id, expected_version: cur.version, patch: {}, actor: system, reason: "x", enqueue: { kind, idempotency_key: key } });
  if (!t.ok) throw new Error("enqueue failed");
  const r = (await store.claimRun({ worker_id: w1, kinds: [kind], lease_ms: LEASE }))!;
  await store.completeRun(r.id, r.lease!.token, data
    ? { status: "succeeded", summary: "", data }
    : { status: "failed", error_code: "tests_failed", detail: "", infra: false });
}

async function block(store: FactoryStore, item: WorkItem, blocked_reason: string) {
  const cur = (await store.getWorkItem(item.id))!;
  const r = await store.transition({ id: item.id, expected_version: cur.version, patch: { stage: "REVIEW", blocked_on: "human", blocked_reason, pr_number: 42 }, actor: system, reason: "x" });
  if (!r.ok) throw new Error("transition failed");
}

/** The items table's rows, as cell lists; the last cell is the conflicts column. */
function rows(body: string): string[][] {
  const start = body.indexOf(`<section id="items">`);
  const list = body.slice(start, body.indexOf("</section>", start));
  const tbody = list.indexOf("<tbody>");
  if (tbody < 0) return [];
  return list
    .slice(tbody + "<tbody>".length, list.indexOf("</tbody>"))
    .split("</tr>")
    .filter((r) => r.includes("<td>"))
    .map((r) => r.split("<td>").slice(1).map((c) => c.slice(0, c.lastIndexOf("</td>"))));
}

describe("dashboard: merge-conflict counts per item", () => {
  it("each row shows how many conflicts were resolved automatically and how many needed a person", async () => {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const a = (await store.createWorkItem(issue(1), system)).item;
    const b = (await store.createWorkItem(issue(2), system)).item;

    // a: one automatic resolve pushed, one implement sync resolved a conflict, a failed automatic attempt,
    // then twice waiting on a person.
    await runOnce(store, a, "resolve", autoResolveKey(a.id, "b1", 1), null);
    await runOnce(store, a, "resolve", autoResolveKey(a.id, "b1", 2), { result: "pushed", conflicts: ["x.ts"] });
    await runOnce(store, a, "implement", `${a.id}:implement:l0:r0`, { pr_number: 42, conflicts: ["y.ts"] });
    await block(store, a, "merge_conflict_pending");
    await block(store, a, "merge_pending");
    await block(store, a, "merge_conflict_pending");

    const page = await renderIndex(deps(store, clock), NO_FILTERS);
    expect(page).toContain(`<th scope="col">conflicts</th>`);
    const byNumber = new Map(rows(page).map((r) => [r[1]!.replace(/<[^>]+>/g, ""), r.at(-1)!]));
    expect(byNumber.get("#1")).toBe("2 automatic · 2 needed a person");
    expect(byNumber.get("#2")).toBe(""); // no conflicts: an empty cell
    expect(b.id).toBeTruthy();
  });

  it("the item page states the same two counts", async () => {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const a = (await store.createWorkItem(issue(3), system)).item;
    await runOnce(store, a, "resolve", autoResolveKey(a.id, "b1", 1), { result: "pushed", conflicts: ["x.ts"] });
    const page = (await renderItem(deps(store, clock), a.id))!;
    expect(page).toContain("merge conflicts");
    expect(page).toContain("1 resolved automatically, 0 needed a person");
  });
});
