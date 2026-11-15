// The `updater` block of factory.config.json, checked at load (loadConfig) and read by the git-worktree plugin.

/** `updater.code_update_interval_ms` absent: a separate code checkout fetches its origin at most every 15 minutes. */
export const CODE_UPDATE_INTERVAL_MS = 15 * 60_000;

/** `updater.auto_migrate` from factory.config.json: absent means false, otherwise a boolean or startup fails. */
export function autoMigrate(updater: { auto_migrate?: unknown } | undefined): boolean {
  const v = updater?.auto_migrate;
  if (v === undefined) return false;
  if (typeof v !== "boolean") throw new Error("updater.auto_migrate must be true or false");
  return v;
}

/**
 * `updater.code_update_interval_ms`: how often a code checkout that is not the project repository fetches its
 * origin (design 08-self-update). Absent: CODE_UPDATE_INTERVAL_MS; anything but a positive integer fails startup.
 */
export function codeUpdateIntervalMs(updater: { code_update_interval_ms?: unknown } | undefined): number {
  const v = updater?.code_update_interval_ms;
  if (v === undefined) return CODE_UPDATE_INTERVAL_MS;
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) throw new Error("updater.code_update_interval_ms must be a positive integer (milliseconds)");
  return v;
}

/** Checks the whole `updater` block at load, so a bad value fails startup before any plugin is built. */
export function updaterConfig(updater: { auto_migrate?: unknown; code_update_interval_ms?: unknown } | undefined): { autoMigrate: boolean; codeUpdateIntervalMs: number } {
  return { autoMigrate: autoMigrate(updater), codeUpdateIntervalMs: codeUpdateIntervalMs(updater) };
}
