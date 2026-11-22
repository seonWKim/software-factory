// GET /api/v1/rules: the excerpt of each waiting proposal (design 09-dashboard-rules): the first changed lines of its
// current and proposed text, at most 3 lines and 200 characters a side, read through TacitLedger.show and the Withholder.
import { describe, expect, it } from "vitest";
import type { UserId } from "../src/core/types.js";
import { baseFromConfig } from "../src/core/settings.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import type { TacitEntryDetail, TacitLedger, TacitPendingEntry } from "../src/interfaces/tacit-ledger.js";
import { HealthMonitor } from "../src/ui/health.js";
import type { PauseDeps, UiPauses } from "../src/ui/pause-api.js";
import { readRuleEntry, readRules } from "../src/ui/rules-api.js";
import { newCsrfToken } from "../src/ui/settings-api.js";
import { enqueueImprove, manualWindow } from "../src/core/improver.js";
import { ASK_PROPOSAL, type AskRow, OWNER_ASK, type ProposalRow, proposalText } from "../src/core/owner-asks.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { PROJECT, config, silent } from "./helpers/fakes/config.js";
import { newStore } from "./helpers/store.js";

const OWNER = "local:owner@example.com" as UserId;
const SECRET = "sekret-token-value-0123456789";

/** The page's deps with a fake ledger that lists `pending` and shows `show`. */
async function deps(pending: TacitPendingEntry[], show: (id: string) => Promise<TacitEntryDetail | null>): Promise<PauseDeps> {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  await store.claimOwner(OWNER);
  const ledger: TacitLedger = {
    enabled: true, capture: async () => {}, pending: async () => pending, show, verdict: async () => {}, rules: async () => [],
  };
  const pauses: UiPauses = { principal: async () => OWNER, authorize: async () => ({ allow: true }), csrfToken: newCsrfToken(), log: silent };
  return {
    store, scanner: new PatternEgressScanner(async () => [SECRET]), clock, lease_ms: 300_000, health: new HealthMonitor(async () => [], clock), pauses,
    settings: { base: baseFromConfig(config), repo: config.repo, actor: OWNER, resolveProject: async () => null, csrfToken: pauses.csrfToken, integrations: [] },
    tacit: { ledger, settings: { refresh: async () => {}, values: () => ({ integrations: {} }) }, home: () => ({ path: "/h", missing: null, homes: [] }) },
  };
}

async function rules(pending: TacitPendingEntry[], show: (id: string) => Promise<TacitEntryDetail | null>) {
  return (await readRules(await deps(pending, show))).value as { entries: { id: string }[]; excerpts: Record<string, { before?: string; after?: string }> };
}

const P = (id: string): TacitPendingEntry => ({ id, title: id, state: "open", kind: "edit-asset", target: "bin/evolve" });

describe("GET /api/v1/rules: excerpts", () => {
  it("gives each waiting proposal the first changed lines, at most 3 lines and 200 characters, through the Withholder", async () => {
    const v = await rules([P("P-1"), P("P-2"), P("P-3"), { id: "C-1", title: "c", state: "pending" }], async (id) => {
      if (id === "P-1") return { id, current: "keep\nold a\nold b\nold c\nold d\nend", proposed: `keep\nnew ${SECRET}\nend` };
      if (id === "P-2") return { id, current: "x".repeat(500), proposed: "short" };
      return { id };
    });
    expect(v.excerpts["P-1"]!.before).toBe("old a\nold b\nold c");
    expect(v.excerpts["P-1"]!.after).toContain("withheld");
    expect(v.excerpts["P-1"]!.after).not.toContain(SECRET);
    expect(v.excerpts["P-2"]!.before).toHaveLength(200);
    expect(v.excerpts["P-2"]!.after).toBe("short");
    // No lines in the ledger: no key; a class has none.
    expect(Object.keys(v.excerpts).sort()).toEqual(["P-1", "P-2"]);
  });

  it("a show that fails or has no lines leaves the proposal without an excerpt and the entries listed", async () => {
    const v = await rules([P("P-1"), P("P-2")], async (id) => {
      if (id === "P-1") throw new Error("evolve show exited 5");
      return null;
    });
    expect(v.excerpts).toEqual({});
    expect(v.entries.map((e) => e.id)).toEqual(["P-1", "P-2"]);
  });
});

describe("GET /api/v1/rules/entry: a prose change", () => {
  it("passes a proposal's change through the Withholder, beside its Why and its evidence rows", async () => {
    const d = await deps([], async (id) => ({ id, target: "skills/review/SKILL.md", change: `paste ${SECRET} first`, root_reason: "tests skipped", incidents: 1, evidence: [{ ref: "T-20261017-de7e" }] }));
    const v = (await readRuleEntry(d, "P-1")).value as { detail: Record<string, unknown> };
    expect(JSON.stringify(v)).not.toContain(SECRET);
    expect(v.detail.change).toMatch(/^\[withheld: /);
    expect(v.detail).toMatchObject({ root_reason: "tests skipped", incidents: 1, evidence: [{ ref: "T-20261017-de7e" }] });
  });
});

describe("GET /api/v1/rules: the improve report's owner asks (design 07-improve-report)", () => {
  it("passes on the top ask reasons with the share approved unchanged, and each standing approval proposal as text", async () => {
    const d = await deps([], async () => null);
    const { run } = await enqueueImprove({ store: d.store as FactoryStore, clock: d.clock }, PROJECT.key, "manual");
    const ask = (reason: string, asks: number, answered: number, approved_unchanged: number): AskRow =>
      ({ error_code: OWNER_ASK, detail: reason, run_ids: [], work_item_ids: [], asks, answered, approved_unchanged });
    const proposal: ProposalRow = { error_code: ASK_PROPOSAL, detail: "spec_pending", run_ids: [], work_item_ids: [], run_length: 10, text: proposalText({ reason: "spec_pending", run_length: 10 }) };
    await (d.store as FactoryStore).recordImproveReport({
      run_id: run!.id, project: PROJECT.key, ...manualWindow(d.clock.now()), groups: [],
      patterns: [{ error_code: "lonely", detail: "x", run_ids: [], work_item_ids: [] }, ask("spec_pending", 4, 4, 3), ask(`run_failed ${SECRET}`, 2, 0, 0), proposal],
    });
    const v = (await readRules(d)).value as { improve: { report: Record<string, any> } };
    const report = v.improve.report;
    expect(report.patterns).toBe(1);
    expect(report.asks).toEqual([
      { reason: "spec_pending", asks: 4, answered: 4, share_unchanged: 0.75 },
      { reason: expect.stringMatching(/^\[withheld: /), asks: 2, answered: 0, share_unchanged: null },
    ]);
    expect(report.proposals).toEqual([{ reason: "spec_pending", run_length: 10, text: expect.stringContaining("`/standing`") }]);
    expect(await (d.store as FactoryStore).listStandingRules()).toEqual([]);
  });
});
