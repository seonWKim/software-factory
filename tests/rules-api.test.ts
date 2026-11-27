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
import { RULE_WRITES, SKILL_VERDICT_PATH, readRuleEntry, readRules, writeSkillVerdict } from "../src/ui/rules-api.js";
import { readProposals } from "../src/ui/improve-api.js";
import { SKILL_IMPROVE_DEFAULTS } from "../src/core/skill-improve-config.js";
import { type SkillImproveWiring, holdSkillDraft, promoteSkillDraft, rejectSkillDraft } from "../src/core/skill-improve.js";
import type { SkillDraftState } from "../src/interfaces/skill-draft-store.js";
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

describe("GET /api/v1/rules: a waiting proposal's gist", () => {
  it("is the first line it adds, else its prose change, description or root reason, marks dropped, through the Withholder; null with none or for a class", async () => {
    const v = (await readRules(await deps([P("P-1"), P("P-2"), P("P-3"), P("P-4"), P("P-5"), { id: "C-1", title: "c", state: "pending" }], async (id) => {
      if (id === "P-1") return { id, current: "keep\nold", proposed: "keep\n- add a line\nmore" };
      if (id === "P-5") return { id, proposed: `use ${SECRET} here` };
      if (id === "P-2") return { id, change: "\n## Split the prompt in two\nthen more", root_reason: "too long" };
      if (id === "P-3") return { id, root_reason: "x".repeat(300) };
      return { id };
    }))).value as { entries: { id: string; gist: string | null }[] };
    const gist = Object.fromEntries(v.entries.map((e) => [e.id, e.gist]));
    expect(gist["P-1"]).toBe("add a line");
    expect(gist["P-5"]).toMatch(/^\[withheld: /);
    expect(gist["P-2"]).toBe("Split the prompt in two");
    expect(gist["P-3"]).toHaveLength(160);
    expect(gist["P-4"]).toBeNull();
    expect(gist["C-1"]).toBeNull();
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

// Skill drafts (design 09-dashboard-rules-waiting): their rows in GET /api/v1/proposals and their verdicts on the Rules
// page, POST /api/v1/rules/skill-verdict, which calls the verdict core (src/core/skill-improve.ts) with a fake wiring.
describe("skill drafts: the proposals list and the Rules page's verdict", () => {
  /** In-memory SKILL.md files under /repo/skills (and one outside); the re-run is counted, no model is called. */
  function fakeWiring() {
    const files = new Map([["/repo/skills/a", "SKILL A"], ["/repo/other/c", "SKILL C"]]);
    const reruns: string[] = [];
    const wiring: SkillImproveWiring = {
      config: SKILL_IMPROVE_DEFAULTS, skill_folders: ["/repo/skills"], folderOf: (ref) => `/repo/${ref}`, prompt: async () => null,
      readSkill: async (f) => files.get(f) ?? null, writeSkill: async (f, t) => void files.set(f, t), version: async () => "v1", newId: () => "n1",
      scratch: async (r) => ({ id: r.run_id, pass_rate: 1 }) as never, rerun: async (r) => (reruns.push(r.skill_ref), null),
    };
    return { wiring, files, reruns };
  }

  async function setup(o: { owner?: boolean; wired?: boolean } = {}) {
    const d = await deps([], async () => null);
    const f = fakeWiring();
    const as = o.owner === false ? ("local:someone@example.com" as UserId) : OWNER;
    const pauses: UiPauses = { ...d.pauses!, principal: async () => as };
    const sd: PauseDeps = { ...d, pauses, settings: { ...d.settings!, resolveProject: async () => PROJECT }, skillImprove: { hold: holdSkillDraft, reject: rejectSkillDraft, promote: promoteSkillDraft, wiring: o.wired === false ? undefined : f.wiring } };
    const store = sd.store as FactoryStore;
    // skills/a has a held-out case, so a promotion runs its held-out check (each scratch run scores 1).
    await store.createSkillEvalSuite({ id: "suite:a", skill_ref: "skills/a", title: "a", created_by: OWNER });
    await store.addSkillEvalCase({ id: "h1", suite_id: "suite:a", input: "held", expected: ["x"], split: "held-out" });
    const add = (id: string, state: SkillDraftState, skill_ref = "skills/a", project_key = PROJECT.key) => store.addSkillDraft({
      id, project_key, skill_ref, state, tokens: 10,
      detail: { draft: "NEW A", model_class: "standard", failed_checks: ["cites the source", `names ${SECRET}`], baseline_run: { id: "r0", pass_rate: 0.5 }, scratch_run: { id: "r1", pass_rate: 0.9 }, ...(state === "tried" ? { reason: "no_gain" } : {}) },
    });
    const verdict = (id: string, v: string) => writeSkillVerdict(sd, pauses, { id, verdict: v });
    return { ...f, sd, store, add, verdict };
  }

  it("GET /api/v1/proposals lists the project's skill drafts beside the entity proposals, each with its state, reason, path, why and time", async () => {
    const { sd, add } = await setup();
    await add("skd_p", "proposed");
    await add("skd_h", "held");
    await add("skd_t", "tried");
    await add("skd_x", "proposed", "skills/a", "github:other");
    const v = (await readProposals(sd)).value as { proposals: unknown[]; skills: Record<string, unknown>[] };
    expect(v.proposals).toEqual([]);
    const byId = Object.fromEntries(v.skills.map((s) => [s.id, s]));
    expect(Object.keys(byId).sort()).toEqual(["skd_h", "skd_p", "skd_t"]);
    expect(byId.skd_p).toMatchObject({ state: "proposed", reason: null, skill_ref: "skills/a", before: 0.5, after: 0.9, created_at: expect.any(String) });
    expect(byId.skd_t).toMatchObject({ state: "tried", reason: "no_gain" });
    // Only a proposed or held draft offers a verdict; Hold only a proposed one.
    expect(byId.skd_p!.verdicts).toEqual(["promote", "hold", "reject"]);
    expect(byId.skd_h!.verdicts).toEqual(["promote", "reject"]);
    expect(byId.skd_t!.verdicts).toEqual([]);
    // The why is the failed checks, through the Withholder; the draft text never leaves.
    expect(byId.skd_p!.why).toMatch(/^\[withheld: /);
    expect(JSON.stringify(v)).not.toContain(SECRET);
    expect(JSON.stringify(v)).not.toContain("NEW A");
  });

  it("is one of the Rules page's write routes", () => {
    expect(RULE_WRITES[SKILL_VERDICT_PATH]).toBe(writeSkillVerdict);
  });

  it("promote writes the draft to SKILL.md, re-runs the suite through the wiring and answers promoted", async () => {
    const { add, verdict, files, reruns, store } = await setup();
    await add("skd_p", "proposed");
    expect(await verdict("skd_p", "promote")).toEqual({ status: 200, value: { id: "skd_p", state: "promoted" } });
    expect(files.get("/repo/skills/a")).toBe("NEW A");
    expect(reruns).toEqual(["skills/a"]);
    expect((await store.getSkillDraft("skd_p"))!.detail).toMatchObject({ old_text: "SKILL A" });
  });

  it("hold and reject change only the draft's state", async () => {
    const { add, verdict, files, store } = await setup();
    await add("skd_p", "proposed");
    expect((await verdict("skd_p", "hold")).value).toEqual({ id: "skd_p", state: "held" });
    expect((await verdict("skd_p", "reject")).value).toEqual({ id: "skd_p", state: "rejected" });
    expect((await store.getSkillDraft("skd_p"))!.state).toBe("rejected");
    expect(files.get("/repo/skills/a")).toBe("SKILL A");
  });

  it("passes the ledger the UI holds: an accepted verdict is recorded there, a refused one sends nothing, and a failure keeps the answer", async () => {
    const { add, sd, store } = await setup();
    const recorded: string[] = [];
    let fail = false, refreshed = 0;
    const ledger = {
      enabled: true, verdictRecord: async (v: { id: string; decision: string }) => { recorded.push(`${v.id}:${v.decision}`); if (fail) throw new Error("ledger locked"); },
    } as unknown as TacitLedger;
    const on: PauseDeps = { ...sd, tacit: { ledger, settings: { refresh: async () => void refreshed++, values: () => ({ integrations: {} }) }, home: () => ({ path: "", missing: null, homes: [] }) } };
    await add("skd_p", "proposed");
    await add("skd_q", "proposed");
    expect((await writeSkillVerdict(on, sd.pauses!, { id: "skd_p", verdict: "hold" })).value).toEqual({ id: "skd_p", state: "held" });
    expect((await writeSkillVerdict(on, sd.pauses!, { id: "skd_p", verdict: "hold" })).status).toBe(409);
    fail = true;
    expect(await writeSkillVerdict(on, sd.pauses!, { id: "skd_q", verdict: "reject" })).toEqual({ status: 200, value: { id: "skd_q", state: "rejected" } });
    expect((await store.getSkillDraft("skd_q"))!.state).toBe("rejected");
    expect(recorded).toEqual(["skd_p:hold", "skd_q:reject"]);
    expect(refreshed).toBeGreaterThan(0);
  });

  it("a verdict the core refuses changes nothing and answers the core's reason", async () => {
    const { add, verdict, files, reruns, store } = await setup();
    await add("skd_t", "tried");
    await add("skd_out", "proposed", "other/c");
    for (const v of ["promote", "hold", "reject"]) {
      const r = await verdict("skd_t", v);
      expect(r).toEqual({ status: 409, value: { error: "skill draft skd_t is tried: nothing changed" } });
    }
    expect(await verdict("skd_out", "promote")).toEqual({ status: 409, value: { error: "other/c is not inside capabilities.skill_folders: nothing written" } });
    expect((await store.getSkillDraft("skd_t"))!.state).toBe("tried");
    expect((await store.getSkillDraft("skd_out"))!.state).toBe("proposed");
    expect(files.get("/repo/other/c")).toBe("SKILL C");
    expect(reruns).toEqual([]);
  });

  it("only the owner judges: anyone else gets 403 and nothing is written", async () => {
    const { add, verdict, files, store } = await setup({ owner: false });
    await add("skd_p", "proposed");
    for (const v of ["promote", "hold", "reject"]) expect((await verdict("skd_p", v)).status).toBe(403);
    expect((await store.getSkillDraft("skd_p"))!.state).toBe("proposed");
    expect(files.get("/repo/skills/a")).toBe("SKILL A");
  });

  it("refuses a bad body (400), another project's draft (404) and Promote with no skill wiring (409), each with nothing written", async () => {
    const { add, verdict, store, sd } = await setup({ wired: false });
    await add("skd_p", "proposed");
    await add("skd_x", "proposed", "skills/a", "github:other");
    const unwired = await writeSkillVerdict({ ...sd, skillImprove: undefined } as never, sd.pauses!, { id: "skd_p", verdict: "hold" });
    expect(unwired.status).toBe(409);
    expect((await verdict("skd_p", "retire")).status).toBe(400);
    expect((await verdict("skd_x", "hold")).status).toBe(404);
    expect((await verdict("skd_none", "hold")).status).toBe(404);
    expect((await verdict("skd_p", "promote")).status).toBe(409);
    expect((await store.getSkillDraft("skd_p"))!.state).toBe("proposed");
    expect((await store.getSkillDraft("skd_x"))!.state).toBe("proposed");
    expect(sd.skillImprove!.wiring).toBeUndefined();
  });
});
