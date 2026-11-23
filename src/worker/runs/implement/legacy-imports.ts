// The implement run's one seam to the legacy core/ and interfaces/ modules: implement.run.ts and the files split
// out of it (implement-sync.ts, implement-checks.ts, implement-wip.ts) import them only through here, so the split
// adds no legacy import edge (dependency-direction and kinds ratchets). When a module moves, only this file changes.
export { AGENT_STOP_CHECKS_DEFAULT, withoutUiCheck } from "../../../core/config.js";
export { settingValues } from "../../../core/settings.js";
export type { ModelClass } from "../../../core/model-choice.js";
export { type DiffStat, type FloorHit, diffStat, overSizeLimit, requiredTier, sizeDetail } from "../../../core/diff-gate.js";
export { NumstatError, diffGates, scopeGate } from "../../../core/pre-push.js";
export { BASE_CHECKOUT_DIR, CHECKS_FAILED_RUN, type CheckResult, type DoneCheckResult, TOOLCHAIN_MISSING, PrePushSelection, checkCommands, checkedLines, checkedLinesText, commandText, doneCheckRound, failingTestFiles, manualLines, toolchainMissing, withTestFiles } from "../../../core/checks.js";
export { IMPLEMENT_SCHEMA, NEEDS_HUMAN_MAX_CHARS, NEEDS_HUMAN_MAX_PATHS, type NeedsHuman, SPEC_CONFLICT, findingLine, parseImplement, parseReview, sizeCaps } from "../../../core/outputs.js";
export { CHECKS_ENV, CHECKS_ENV_LIMIT, PREFLIGHT_FAILED, branchFor, isCovered, wipBranchFor } from "../../../core/policy.js";
export { mergeAppendedConflicts } from "../../../core/mechanical.js";
export { type ConflictFile, renderResolvePrompt } from "../../../core/resolve.js";
export { errorText } from "../../../core/log.js";
export type { Run, RunResume, WipRef, WorkItem } from "../../../core/types.js";
export type { AgentRunSpec, GateHooks, PackRefusal, StopSelection } from "../../../interfaces/agent-runner.js";
export type { SandboxHandle } from "../../../interfaces/sandbox.js";
export { PREFLIGHT, type ToolCallContext } from "../../../interfaces/tool-broker.js";
