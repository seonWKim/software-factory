// Settings as discovered descriptors (RFC 0015 §6.1, §8 "Settings only tighten"; RFC 0013 F4). Each setting is
// one `src/<owner>/settings/<key>.setting.ts` file, found by discovery; nothing lists them by hand, and the settings
// catalog (docs/settings.md) is generated from them. Pure: no I/O.

/** Settings levels, highest first (RFC 0015 §8). A lower level may only tighten what a higher one set. */
export const SETTING_LEVELS = ["owner", "org", "project", "pack", "user"] as const;
export type SettingLevel = (typeof SETTING_LEVELS)[number];

/**
 * Which way is tighter for a `tighten-only` setting:
 * - `lower` / `higher`: a number; the lower (higher) value is the tighter one.
 * - `more` / `fewer`: a list; a superset (subset) is tighter.
 * - an array: an enum, tightest value first (`["manual", "auto"]`).
 * - `fixed`: no order; a lower level may only repeat the value above it.
 * - a function: why `value` is looser than `than`, or null when it is equal or tighter.
 */
export type Tighter =
  | "lower"
  | "higher"
  | "more"
  | "fewer"
  | "fixed"
  | readonly (string | boolean)[]
  | ((value: unknown, than: unknown) => string | null);

export type SettingType = "integer" | "boolean" | "enum" | "object" | "list" | "string";

export interface SettingDescriptor<T = unknown> {
  readonly kind: "setting";
  /** The key as `factory settings` and factory.config.json name it. */
  readonly key: string;
  /** The component that reads it; the file lives in `src/<owner>/settings/`. */
  readonly owner: string;
  readonly type: SettingType;
  /** The built-in default; null when the key has none (the config file must say). */
  readonly default: T | null;
  /** One plain sentence, at most 100 characters: what it controls. */
  readonly description: string;
  /** When a runtime change takes effect; null for a key that changes by review only. */
  readonly applies: string | null;
  /** tighten-only: a lower level may only tighten it (`settings-monotonic`). free: any level may set any value. */
  readonly direction: "tighten-only" | "free";
  readonly tighter?: Tighter;
  /** runtime: `factory settings set`, audited. review: only by a reviewed change to factory.config.json. */
  readonly changed_by: "runtime" | "review";
  /** global: one value. project: a project level may hold its own value (tighter, when tighten-only). */
  readonly scope: "global" | "project";
  /** A guard (G1, G2, G5 and the agent read denies): switched only by review, never loosened at any level. */
  readonly guard?: boolean;
  /** A dial (autonomy, floors, permissions): loosening it needs review or the grant in `change_needs`. */
  readonly dial?: boolean;
  /** The grant a runtime change needs (`approve_merge` for the autonomy dials). */
  readonly change_needs?: string;
}

export const SETTING_KEY = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)?$/;

/** The descriptor's file name: the key with `_` and `.` as `-` (`standing_approvals.threshold` → `standing-approvals-threshold`). */
export function settingFileName(key: string): string {
  return key.replace(/[_.]/g, "-");
}

/** Why the setting is inconsistent, or [] (run at definition, so a bad file fails on import). */
export function settingProblems(s: Omit<SettingDescriptor, "kind">): string[] {
  const out: string[] = [];
  if (!SETTING_KEY.test(s.key)) out.push(`setting key "${s.key}" must be snake_case, with at most one dot`);
  if (s.description.length === 0 || s.description.length > 100) out.push(`${s.key}: description must be 1–100 characters`);
  if (s.direction === "tighten-only" && s.tighter === undefined) out.push(`${s.key}: a tighten-only setting needs \`tighter\``);
  if (s.direction === "free" && s.tighter !== undefined) out.push(`${s.key}: a free setting has no \`tighter\``);
  if (s.guard && (s.direction !== "tighten-only" || s.changed_by !== "review")) out.push(`${s.key}: a guard is tighten-only and changes by review only`);
  if (s.dial && s.changed_by === "runtime" && !s.change_needs) out.push(`${s.key}: a dial changed at runtime needs a grant (\`change_needs\`)`);
  if ((s.changed_by === "runtime") !== (s.applies !== null)) out.push(`${s.key}: \`applies\` is set exactly when the key changes at runtime`);
  return out;
}

export function defineSetting<T>(s: Omit<SettingDescriptor<T>, "kind">): SettingDescriptor<T> {
  const problems = settingProblems(s as Omit<SettingDescriptor, "kind">);
  if (problems.length > 0) throw new Error(problems.join("; "));
  return { kind: "setting", ...s };
}

/** Why `value` would loosen `s` past `than` (the value of a higher level), or null when equal or tighter. */
export function loosens(s: SettingDescriptor, value: unknown, than: unknown): string | null {
  if (s.direction === "free" || than === undefined || than === null) return null;
  const t = s.tighter!;
  const show = (v: unknown) => JSON.stringify(v);
  if (typeof t === "function") return t(value, than);
  if (t === "fixed") return show(value) === show(than) ? null : `${s.key} may not change below the level that set it`;
  if (t === "lower" || t === "higher") {
    const v = value as number;
    const h = than as number;
    const loose = t === "lower" ? v > h : v < h;
    return loose ? `${s.key} ${v} is ${t === "lower" ? "above" : "below"} ${h}, the value above it` : null;
  }
  if (t === "more" || t === "fewer") {
    const v = new Set((value as readonly unknown[]).map(show));
    const h = (than as readonly unknown[]).map(show);
    if (t === "more") {
      const dropped = h.find((x) => !v.has(x));
      return dropped === undefined ? null : `${s.key} drops ${dropped}, which the level above it set`;
    }
    const added = [...v].find((x) => !h.includes(x));
    return added === undefined ? null : `${s.key} adds ${added}, which the level above it does not allow`;
  }
  const rank = (x: unknown) => t.indexOf(x as string | boolean);
  if (rank(value) < 0) return `${s.key} ${show(value)} is not one of ${t.map(show).join(", ")}`;
  return rank(value) > rank(than) ? `${s.key} ${show(value)} is looser than ${show(than)}, the value above it` : null;
}
