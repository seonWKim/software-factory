// Runtime component (RFC 0015 §7): discovery and the extension points — the settings catalog and its
// tighten-only levels, run roles with their Rule of Two profile, and hooks. Other components import only this file.

export { CODE_ROOT, SettingCatalog, loadSettingCatalog, renderSettingCatalog } from "./settings/catalog.js";
export { monotonicProblems, resolveLevels, type LevelValue, type Resolved } from "./settings/monotonic.js";
export { DEFAULT_GOLDEN_ROLE, RoleCatalog, goldenCasesByRole, loadRoles, rolesShortOfGolden } from "./run-roles/run-roles.js";
export { HOOK_PATH, TEXT_MAX, loadHooks, runHooks, type HookAudit, type HookDecision, type HookOutcomeKind, type HookResult } from "./hooks/run-hooks.js";
export { SqlHookAudit } from "./hooks/sql-hook-audit.js";
export { ensureDiscoveredTopicTables } from "./registry/topic-tables.js";
