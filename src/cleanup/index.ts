// The cleanup of closed items' leftovers on this host (design 08-cleanup): the pass, its handlers' contract and
// discovery, the shared removal-safety helper (teardown uses it too), the config block and the CLI's report.

export { CLEANUP_DEFAULTS, CLEANUP_KEYS, type CleanupConfig, cleanupConfig, cleanupProblems } from "./config.js";
export { HANDLERS_DIR, cleanupHandlers, discoverHandlers } from "./discover.js";
export { type CleanupEnv, type CleanupHandlerDescriptor, type HostProcess, type ProcessTable, type Resource, defineCleanupHandler } from "./handler.js";
export { hostProcesses, parseLsofCwd } from "./host-processes.js";
export { type MergedRule, folderUnsafe, mergedRule } from "./removal-safety.js";
export { CLEANUP_ACTOR, CLEANUP_REASON, Cleaner, type CleanerDeps, type CleanupStore, type Decision, type PassResult } from "./sweep.js";
export { reportLines } from "./report.js";
