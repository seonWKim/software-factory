// The `cleanup` block of factory.config.json (design 08-cleanup): file-only, like `retention`, so a shorter keep
// changes only by a reviewed PR. config-keys.ts checks it at load; compose and the CLI read it with cleanupConfig.

/** What the cleanup reads from the config. */
export interface CleanupConfig {
  /** False: no close callback and no sweep remove anything. */
  enabled: boolean;
  /** Hours a closed item's resources stay after its close, so a failed merge can still be inspected. */
  keep_hours: number;
}

export const CLEANUP_DEFAULTS: CleanupConfig = { enabled: true, keep_hours: 24 };
export const CLEANUP_KEYS = ["enabled", "keep_hours"] as const satisfies readonly (keyof CleanupConfig)[];

/** Each problem of the file's `cleanup` block, naming its key; [] when it is absent or well formed. */
export function cleanupProblems(raw: unknown): string[] {
  const block = isObject(raw) ? raw.cleanup : undefined;
  if (block === undefined) return [];
  if (!isObject(block)) return ["cleanup must be an object"];
  const out: string[] = [];
  if (block.enabled !== undefined && typeof block.enabled !== "boolean") out.push("cleanup.enabled must be true or false");
  const keep = block.keep_hours;
  if (keep !== undefined && (typeof keep !== "number" || !Number.isInteger(keep) || keep < 0)) out.push("cleanup.keep_hours must be an integer of 0 or more");
  return out;
}

/** The file's `cleanup` block with each absent key at its default; throws on a problem cleanupProblems names. */
export function cleanupConfig(file: unknown): CleanupConfig {
  const problems = cleanupProblems(file);
  if (problems.length > 0) throw new Error(problems.join("; "));
  const block = (isObject(file) && isObject(file.cleanup) ? file.cleanup : {}) as Partial<CleanupConfig>;
  return { enabled: block.enabled ?? CLEANUP_DEFAULTS.enabled, keep_hours: block.keep_hours ?? CLEANUP_DEFAULTS.keep_hours };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
