// `factory improve skill <id> promote|hold|reject` (design 09-dashboard-rules-waiting): the CLI verb runs the Rules
// page's verdict function on the dashboard's parts, so the CLI and the page give the same result. buildUiParts is
// faked with an in-memory store and a fake skill wiring: no model is called.
import { afterEach, describe, expect, it, vi } from "vitest";
import improve from "../src/cli/handlers/improve/improve.command.js";
import type { CommandContext } from "../src/cli/command.js";
import { SKILL_IMPROVE_DEFAULTS } from "../src/core/skill-improve-config.js";
import { type SkillImproveWiring, holdSkillDraft, promoteSkillDraft, rejectSkillDraft } from "../src/core/skill-improve.js";
import type { UserId } from "../src/core/types.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import type { SkillDraftState } from "../src/interfaces/skill-draft-store.js";
import type { UiPauses } from "../src/ui/pause-api.js";
import { writeSkillVerdict } from "../src/ui/rules-api.js";
import { PROJECT, silent } from "./helpers/fakes/config.js";
import { newStore } from "./helpers/store.js";

const built = vi.hoisted(() => ({ parts: null as unknown }));
vi.mock("../src/compose.js", async () => ({
  build: async () => { throw new Error("not used"); }, buildUiParts: async () => built.parts, writeSkillVerdict: (await import("../src/ui/rules-api.js")).writeSkillVerdict,
}));

const OWNER = "local:owner@example.com" as UserId;

afterEach(() => {
  built.parts = null;
  vi.restoreAllMocks();
});

/** The dashboard's parts as buildUiParts returns them, over a fresh store: the owner check, the project and the fake wiring. */
async function parts(as: UserId = OWNER) {
  const { store } = await newStore();
  await store.claimOwner(OWNER);
  const files = new Map([["/repo/skills/a", "SKILL A"], ["/repo/other/c", "SKILL C"]]);
  const reruns: string[] = [];
  const wiring: SkillImproveWiring = {
    config: SKILL_IMPROVE_DEFAULTS, skill_folders: ["/repo/skills"], folderOf: (ref) => `/repo/${ref}`, prompt: async () => null,
    readSkill: async (f) => files.get(f) ?? null, writeSkill: async (f, t) => void files.set(f, t), version: async () => "v1", newId: () => "n1",
    scratch: async (r) => ({ id: r.run_id, pass_rate: 1 }) as never, rerun: async (r) => (reruns.push(r.skill_ref), null),
  };
  // skills/a has a held-out case, so a promotion runs its held-out check (each scratch run scores 1).
  await (store as FactoryStore).createSkillEvalSuite({ id: "suite:a", skill_ref: "skills/a", title: "a", created_by: OWNER });
  await (store as FactoryStore).addSkillEvalCase({ id: "h1", suite_id: "suite:a", input: "held", expected: ["x"], split: "held-out" });
  const pauses: UiPauses = { principal: async () => as, authorize: async () => ({ allow: true }), csrfToken: "t", log: silent };
  const skillImprove = { hold: holdSkillDraft, reject: rejectSkillDraft, promote: promoteSkillDraft, wiring };
  const p = { store, pauses, settings: { resolveProject: async () => PROJECT }, skillImprove, close: async () => {} };
  for (const [id, state, ref] of [["skd_p", "proposed", "skills/a"], ["skd_h", "held", "skills/a"], ["skd_t", "tried", "skills/a"], ["skd_out", "proposed", "other/c"]] as const) {
    await (store as FactoryStore).addSkillDraft({ id, project_key: PROJECT.key, skill_ref: ref, state: state as SkillDraftState, tokens: 1, detail: { draft: `NEW ${id}`, model_class: "standard" } });
  }
  return { p, store: store as FactoryStore, files, reruns };
}

/** Runs the CLI on `p`; its exit code and what it printed. */
async function cli(p: unknown, args: string[]) {
  built.parts = p;
  const out: string[] = [];
  vi.spyOn(console, "log").mockImplementation((m: string) => void out.push(m));
  vi.spyOn(console, "error").mockImplementation((m: string) => void out.push(m));
  const ctx = { load: async () => ({}), identity: async () => ({ user: OWNER }) } as unknown as CommandContext;
  const code = await improve.run(args, ctx);
  vi.restoreAllMocks();
  return { code, out: out.join("\n") };
}

/** The store's drafts and the skill files after `run`, to compare the CLI with the route. */
async function effect(run: (p: Awaited<ReturnType<typeof parts>>) => Promise<unknown>) {
  const s = await parts();
  await run(s);
  const states = Object.fromEntries(await Promise.all(["skd_p", "skd_h", "skd_t", "skd_out"].map(async (id) => [id, (await s.store.getSkillDraft(id))!.state])));
  return { states, files: Object.fromEntries(s.files), reruns: s.reruns };
}

describe("factory improve skill <id> <verdict>", () => {
  const cases: [string, string][] = [["skd_p", "promote"], ["skd_h", "promote"], ["skd_p", "hold"], ["skd_p", "reject"], ["skd_h", "reject"], ["skd_t", "hold"], ["skd_out", "promote"]];
  for (const [id, verdict] of cases) {
    it(`${verdict} of ${id} has the same effect from the CLI as from the Rules page`, async () => {
      const page = await effect((s) => writeSkillVerdict(s.p as never, s.p.pauses, { id, verdict }));
      const viaCli = await effect((s) => cli(s.p, ["skill", id, verdict]));
      expect(viaCli).toEqual(page);
    });
  }

  it("prints the draft's new state; promote writes the draft and re-runs the suite through the wiring", async () => {
    const s = await parts();
    expect(await cli(s.p, ["skill", "skd_p", "promote"])).toEqual({ code: 0, out: "skill draft skd_p is promoted" });
    expect(s.files.get("/repo/skills/a")).toBe("NEW skd_p");
    expect(s.reruns).toEqual(["skills/a"]);
  });

  it("a refused verdict exits 1 with the core's reason and changes nothing", async () => {
    const s = await parts();
    expect(await cli(s.p, ["skill", "skd_t", "promote"])).toEqual({ code: 1, out: "skill draft skd_t is tried: nothing changed" });
    expect(await cli(s.p, ["skill", "skd_out", "promote"])).toEqual({ code: 1, out: "other/c is not inside capabilities.skill_folders: nothing written" });
    expect((await s.store.getSkillDraft("skd_out"))!.state).toBe("proposed");
    expect(s.files.get("/repo/other/c")).toBe("SKILL C");
  });

  it("only the owner judges: anyone else exits 1 and nothing is written", async () => {
    const s = await parts("local:someone@example.com" as UserId);
    const r = await cli(s.p, ["skill", "skd_p", "reject"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("Only the owner");
    expect((await s.store.getSkillDraft("skd_p"))!.state).toBe("proposed");
  });

  it("a missing argument or an unknown verdict prints the usage", async () => {
    const s = await parts();
    expect(await cli(s.p, ["skill", "skd_p"])).toEqual({ code: 1, out: "usage: factory improve skill <draft id> promote|hold|reject" });
    expect((await cli(s.p, ["skill", "skd_p", "retire"])).out).toContain("usage: factory improve skill");
  });

  it("its usage line in the CLI help names the verb", () => {
    expect(improve.usage).toContain("improve skill <draft id> promote|hold|reject");
  });
});
