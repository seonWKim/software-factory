// Shared by the eval route test files (tests/evals-api, evals-labels-api, evals-starter-api): the owner, the skill,
// the scanners, one seeded store and the read helpers.

import type { UserId } from "../../src/core/types.js";
import type { EgressScanner } from "../../src/interfaces/egress-scanner.js";
import type { FactoryStore } from "../../src/interfaces/factory-store.js";
import { readApi } from "../../src/ui/read-routes.js";
import type { ServerDeps, UiRequest } from "../../src/ui/server.js";
import { newStore } from "./store.js";

export const OWNER = "local:owner" as UserId;
export const SKILL = "skills/tests-first";
export const REQ: UiRequest = { method: "GET", url: undefined, host: "127.0.0.1" };
export const CLEAN: EgressScanner = { scan: async () => ({ clean: true }) };
/** Flags any text holding LEAK. */
export const FLAGGING: EgressScanner = { scan: async (channel, t) => (t.includes("LEAK") ? { clean: false, findings: [{ rule: "test_rule", channel }] } : { clean: true }) };

export async function seeded() {
  const { store, clock } = await newStore();
  await store.createSkillEvalSuite({ id: "s1", skill_ref: SKILL, title: "t", created_by: OWNER });
  await store.createSkillEvalSuite({ id: "s2", skill_ref: "skills/other", title: "o", created_by: OWNER });
  await store.startSkillEvalRun({ id: "old", suite_id: "s1", created_by: OWNER });
  await store.finishSkillEvalRun("old", "passed");
  clock.advance(1000);
  await store.startSkillEvalRun({ id: "elsewhere", suite_id: "s2", created_by: OWNER });
  clock.advance(1000);
  await store.startSkillEvalRun({ id: "new", suite_id: "s1", created_by: OWNER, skill_version: "LEAK-v2" });
  await store.finishSkillEvalRun("new", "failed");
  await store.recordSkillEvalRunFigures("new", { model_class: "standard", judge_model_class: "strong", replays: 2, pass_rate: 0.5, errored: 1 });
  return store;
}

export const get = (store: FactoryStore, scanner: EgressScanner, path: string) =>
  readApi({ store, scanner } as unknown as ServerDeps, new URL(`http://127.0.0.1${path}`), REQ);

/** Every row of the eval tables, to show a read wrote nothing. */
export const tables = async (store: Awaited<ReturnType<typeof seeded>>) =>
  Promise.all(["runs", "suites", "cases", "replays"].map((t) => store.db.all(`SELECT * FROM controller_skill_eval_${t}`)));

export const HOST = "127.0.0.1:4310";
export const ORIGIN = `http://${HOST}`;
