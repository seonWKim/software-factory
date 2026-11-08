import { describe, expect, it } from "vitest";
import { saveProjectLabel } from "../../src/core/project-labels.js";
import type { WorkItem } from "../../src/core/types.js";
import { FakeClock } from "../../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../../src/impl/egress/pattern-egress-scanner.js";
import type { FactoryStore } from "../../src/interfaces/factory-store.js";
import { HealthMonitor } from "../../src/ui/health.js";
import { needOf } from "../../src/ui/need.js";
import { type UiDeps, renderItem } from "../../src/ui/pages.js";
import { PROJECT } from "../helpers/fakes.js";
import { issue, newStore, system } from "../helpers/store.js";

// The UI builds no forge link: a PR link is the item's stored change_url, the change_ref alone is plain text.

function deps(store: FactoryStore, clock: FakeClock): UiDeps {
  return { store, scanner: new PatternEgressScanner(async () => []), clock, lease_ms: 60_000, health: new HealthMonitor(async () => [], clock) };
}

async function mergePending(store: FactoryStore, n: number): Promise<WorkItem> {
  const { item } = await store.createWorkItem(issue(n), system);
  const r = await store.transition({
    id: item.id, expected_version: item.version, actor: system, reason: "seed",
    patch: { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", change_ref: String(n) },
  });
  if (!r.ok) throw new Error(r.reason);
  return r.item;
}

const ctx = (store: FactoryStore) => ({ store, text: async (v: string) => v });

describe("ui: PR links come only from the stored change_url", () => {
  it("with a stored change_url: Needs you and the item page link to it", async () => {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    await saveProjectLabel(store, PROJECT);
    const it0 = await mergePending(store, 7);
    expect(it0.change_url).toBe("https://github.com/o/r/pull/7");
    expect(await needOf(ctx(store), it0)).toMatchObject({ url: it0.change_url, label: "PR #7" });
    expect(await renderItem(deps(store, clock), it0.id)).toContain(`<a href="${it0.change_url}">PR #7</a>`);
  });

  it("with a change_ref and no change_url: the ref as plain text, no PR link anywhere", async () => {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const it0 = await mergePending(store, 8);
    expect(it0).toMatchObject({ change_ref: "8", change_url: null });
    // A label stored later builds no link: the UI reads only the stored column.
    await saveProjectLabel(store, PROJECT);
    expect(await needOf(ctx(store), it0)).toMatchObject({ url: it0.source.link, label: "issue" });
    const page = (await renderItem(deps(store, clock), it0.id))!;
    expect(page).toContain("PR #8");
    expect(page).not.toContain("/pull/8");
  });

  it("with no change_ref: no PR text", async () => {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const { item } = await store.createWorkItem(issue(9), system);
    expect(await renderItem(deps(store, clock), item.id)).not.toContain("PR #");
  });
});
