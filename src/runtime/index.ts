// Runtime component (RFC 0015 §7): discovery and the extension points — the settings catalog and its
// tighten-only levels, run roles with their Rule of Two profile, hooks, and the skill-eval engine with its shared replay. Other components import only this file.

export { SettingCatalog, loadSettingCatalog, renderSettingCatalog } from "./settings/catalog.js";
export { monotonicProblems, type LevelValue, type Resolved } from "./settings/monotonic.js";
export { ROLES_DIR, RoleCatalog, goldenCasesByRole, loadRoles, rolesShortOfGolden } from "./run-roles/run-roles.js";
export { HOOK_PATH, TEXT_MAX, loadHooks, runHooks, type HookAudit, type HookDecision, type HookOutcomeKind, type HookResult } from "./hooks/run-hooks.js";
export { SqlHookAudit } from "./hooks/sql-hook-audit.js";
export { ensureDiscoveredTopicTables } from "./registry/topic-tables.js";
export { loadDescriptors } from "./registry/registry.js";
export { replayInSandbox, type ReplayRequest, type ReplayRunSpec, type ReplayRunner, type ReplaySandbox } from "./skill-evals/replay.js";
export {
  judgeCase, rubricChecks, runSkillEval, skillEvalReplay,
  type CaseVerdict, type SkillEvalEngineDeps, type SkillEvalEngineStore, type SkillEvalOutcome, type SkillEvalRunInput, type SkillJudgeFn, type SkillReplay,
} from "./skill-evals/engine.js";
export { addSkillEvalCase, addSkillEvalSuite, caseFromRun, deleteSkillEvalSuite, editSkillEvalCase, renameSkillEvalSuite, tryCase, validateCase, type Authored, type CaseFields, type SkillEvalAuthoring, type SkillEvalAuthoringStore, type TriedCase } from "./skill-evals/authoring.js";
