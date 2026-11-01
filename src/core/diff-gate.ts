import type { FactoryConfig } from "./config.js";
import type { Tier } from "./types.js";

// Pre-push diff gates (design §4): size limit and floor check on the files a branch really changes.
// Pure: same input, same output. The worker runs git; these functions only read its output.

/** Defaults for `max_diff_lines` and `max_diff_files` when factory.config.json leaves them out. */
export const DIFF_LIMIT_DEFAULTS = { max_diff_lines: 1500, max_diff_files: 40 } as const;

export interface DiffStat {
  /** Added plus deleted lines over all text files. A binary file adds zero. */
  lines: number;
  /** Changed files. A rename (old → new) is one file; a binary file is one file. */
  files: number;
  /** Every path the diff touches, sorted and without duplicates. A rename gives both its old and new path. */
  paths: string[];
}

const ENTRY = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/;

/**
 * Parses `git diff --numstat -z`. Each entry is `<added>\t<deleted>\t<path>\0`, or, for a rename or copy,
 * `<added>\t<deleted>\t\0<old>\0<new>\0`. A binary file shows `-` for both counts.
 */
export function diffStat(numstatZ: string): DiffStat {
  const tokens = numstatZ.split("\0");
  const paths = new Set<string>();
  let lines = 0;
  let files = 0;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok === "") continue;
    const m = ENTRY.exec(tok);
    if (!m) throw new Error(`unexpected numstat entry: ${JSON.stringify(tok.slice(0, 80))}`);
    const [, added, deleted, path] = m as unknown as [string, string, string, string];
    if (path === "") {
      const from = tokens[i + 1];
      const to = tokens[i + 2];
      if (!from || !to) throw new Error("truncated numstat rename entry");
      paths.add(from);
      paths.add(to);
      i += 2;
    } else {
      paths.add(path);
    }
    files++;
    lines += (added === "-" ? 0 : Number(added)) + (deleted === "-" ? 0 : Number(deleted));
  }
  return { lines, files, paths: [...paths].sort() };
}

export type DiffLimits = Pick<FactoryConfig, "max_diff_lines" | "max_diff_files">;

/** Whether the diff is over either limit. Exactly at a limit passes. */
export function overSizeLimit(stat: Pick<DiffStat, "lines" | "files">, limits: DiffLimits): boolean {
  return stat.lines > limits.max_diff_lines || stat.files > limits.max_diff_files;
}

/** The run's failure detail and issue text for an over-limit diff: both counts and both limits. */
export function sizeDetail(stat: Pick<DiffStat, "lines" | "files">, limits: DiffLimits): string {
  return (
    `the diff changes ${stat.lines} lines (limit max_diff_lines = ${limits.max_diff_lines}) ` +
    `in ${stat.files} files (limit max_diff_files = ${limits.max_diff_files})`
  );
}

export interface FloorHit {
  path: string;
  /** The highest floor tier whose prefix the path is under. */
  tier: Tier;
}

/**
 * The changed paths under a floor whose tier is above `itemTier`, each with the tier it needs, sorted by
 * path. Empty means the floors allow the push. A path is under a floor when it starts with the prefix
 * (so a file prefix like `factory.config.json` matches that file).
 */
export function floorHits(paths: readonly string[], floors: FactoryConfig["floors"], itemTier: Tier): FloorHit[] {
  const hits: FloorHit[] = [];
  for (const path of [...new Set(paths)].sort()) {
    let need: Tier | null = null;
    for (const f of floors) if (path.startsWith(f.prefix) && (need === null || f.tier > need)) need = f.tier;
    if (need !== null && need > itemTier) hits.push({ path, tier: need });
  }
  return hits;
}

/** The tier a floor block needs: the highest tier among its hits. */
export function requiredTier(hits: readonly FloorHit[]): Tier | null {
  return hits.reduce<Tier | null>((max, h) => (max === null || h.tier > max ? h.tier : max), null);
}
