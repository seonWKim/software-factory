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
import { readRules } from "../src/ui/rules-api.js";
import { newCsrfToken } from "../src/ui/settings-api.js";
import { config, silent } from "./helpers/fakes.js";
import { newStore } from "./helpers/store.js";

const OWNER = "local:owner@example.com" as UserId;
const SECRET = "sekret-token-value-0123456789";

async function rules(pending: TacitPendingEntry[], show: (id: string) => Promise<TacitEntryDetail | null>) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  await store.claimOwner(OWNER);
  const ledger: TacitLedger = {
    enabled: true, capture: async () => {}, pending: async () => pending, show, verdict: async () => {}, rules: async () => [],
  };
  const pauses: UiPauses = { principal: async () => OWNER, authorize: async () => ({ allow: true }), csrfToken: newCsrfToken(), log: silent };
  const d: PauseDeps = {
    store, scanner: new PatternEgressScanner(async () => [SECRET]), clock, lease_ms: 300_000, health: new HealthMonitor(async () => [], clock), pauses,
    settings: { base: baseFromConfig(config), repo: config.repo, actor: OWNER, resolveProject: async () => null, csrfToken: pauses.csrfToken, integrations: [] },
    tacit: { ledger, settings: { refresh: async () => {}, values: () => ({ integrations: {} }) }, home: () => ({ path: "/h", missing: null, homes: [] }) },
  };
  return (await readRules(d)).value as { entries: { id: string }[]; excerpts: Record<string, { before?: string; after?: string }> };
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
