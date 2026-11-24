// Migration timestamps in a triage answer. A migration is
// `src/<component>/migrations/<yyyymmddThhmm>-<component>-<slug>.migration.ts` and its test
// `tests/<yyyymmddThhmm>-<component>-<slug>.test.ts`; tests/architecture/migration-naming.test.ts refuses two
// migrations with one timestamp. A spec may write the timestamp as the placeholder `<stamp>` (STAMP_PLACEHOLDER):
// the implementer takes the next free one. Pure: the taken names come from the caller (the base branch's tree).

/** The text a spec writes in place of a migration timestamp the implementer picks. */
export const STAMP_PLACEHOLDER = "<stamp>";
const STAMP = String.raw`(\d{8}T\d{4}|${STAMP_PLACEHOLDER})`;
const SLUG = String.raw`([a-z]+)-([a-z0-9]+(?:-[a-z0-9]+)*)`;
const MIGRATION = new RegExp(String.raw`^src/([a-z]+)/migrations/${STAMP}-${SLUG}\.migration\.ts$`);
const MIGRATION_TEST = new RegExp(String.raw`^tests/${STAMP}-${SLUG}\.test\.ts$`);

/** A migration or migration test path, split into its parts; `folder` is where the file sits. */
interface Stamped {
  kind: "migration" | "test";
  folder: string;
  stamp: string;
  component: string;
  slug: string;
}

function stamped(path: string): Stamped | null {
  const m = MIGRATION.exec(path);
  if (m) return m[1] === m[3] ? { kind: "migration", folder: `src/${m[1]}/migrations/`, stamp: m[2]!, component: m[3]!, slug: m[4]! } : null;
  const t = MIGRATION_TEST.exec(path);
  return t ? { kind: "test", folder: "tests/", stamp: t[1]!, component: t[2]!, slug: t[3]! } : null;
}

function pathOf(s: Stamped, stamp: string): string {
  return s.kind === "migration" ? `${s.folder}${stamp}-${s.component}-${s.slug}.migration.ts` : `${s.folder}${stamp}-${s.component}-${s.slug}.test.ts`;
}

/**
 * Whether `path` is a migration (or migration test) with the same folder, component and slug as `allowed`, at any
 * timestamp; `allowed` may hold one or `<stamp>`. The implementer takes the next free timestamp (isCovered).
 */
export function sameSlugMigrationOf(path: string, allowed: string): boolean {
  const p = stamped(path), a = stamped(allowed);
  return p !== null && a !== null && p.kind === a.kind && p.folder === a.folder && p.component === a.component && p.slug === a.slug;
}

/** The minute after `stamp` (yyyymmddThhmm, read as UTC), in the same form. */
export function nextMinute(stamp: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})$/.exec(stamp);
  if (!m) throw new Error(`not a migration timestamp: ${stamp}`);
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]! + 1));
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}T${two(d.getUTCHours())}${two(d.getUTCMinutes())}`;
}

/** Each migration file's timestamp, with the file it belongs to, from paths under `src/<component>/migrations/`. */
export function takenStamps(paths: readonly string[]): Map<string, string> {
  const taken = new Map<string, string>();
  for (const p of paths) {
    const s = stamped(p);
    if (s?.kind === "migration" && s.stamp !== STAMP_PLACEHOLDER) taken.set(s.stamp, p);
  }
  return taken;
}

/** Every string in `v` with each `from` replaced by its `to`; other values as they are. */
function renamed(v: unknown, renames: ReadonlyMap<string, string>): unknown {
  if (typeof v === "string") {
    let s = v;
    for (const [from, to] of renames) s = s.split(from).join(to);
    return s;
  }
  if (Array.isArray(v)) return v.map((x) => renamed(x, renames));
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, renamed(x, renames)]));
  return v;
}

/**
 * The triage answer with each new migration whose timestamp another migration file uses (`taken`, from the base
 * branch) moved to the first later minute no migration uses, same component and slug; its test
 * `tests/<ts>-<component>-<slug>.test.ts` moves with it. The paths are replaced everywhere in the answer
 * (allowed_paths, files_to_change, done_checks, the text). A migration that is already the taken file (an edit
 * of an existing one) keeps its name, and a `<stamp>` path is left for the implementer. Nothing taken: the answer itself, unchanged. `renames`: each old path's new one.
 */
export function freeMigrationStamps(answer: unknown, taken: ReadonlyMap<string, string>): { answer: unknown; renames: Map<string, string> } {
  const renames = new Map<string, string>();
  const a = answer as { allowed_paths?: unknown; files_to_change?: unknown } | null;
  const listed = [a?.allowed_paths, a?.files_to_change].flatMap((l) => (Array.isArray(l) ? l.filter((p): p is string => typeof p === "string") : []));
  const used = new Map(taken);
  for (const path of new Set(listed)) {
    const s = stamped(path);
    if (s?.kind !== "migration" || s.stamp === STAMP_PLACEHOLDER) continue;
    const owner = used.get(s.stamp);
    if (owner === undefined || owner === path) {
      used.set(s.stamp, path);
      continue;
    }
    let stamp = nextMinute(s.stamp);
    while (used.has(stamp)) stamp = nextMinute(stamp);
    const to = pathOf(s, stamp);
    used.set(stamp, to);
    renames.set(path, to);
    renames.set(pathOf({ ...s, kind: "test", folder: "tests/" }, s.stamp), pathOf({ ...s, kind: "test", folder: "tests/" }, stamp));
  }
  return renames.size === 0 ? { answer, renames } : { answer: renamed(answer, renames), renames };
}
