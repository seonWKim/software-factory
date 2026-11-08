// Settings only tighten (RFC 0015 §8, `settings-monotonic`). A value at a lower level that would loosen what a
// higher level set is ignored, and the reason reported; a guard is set at the owner level only.

import { SETTING_LEVELS, type SettingDescriptor, type SettingLevel, loosens } from "../../shared/setting.js";

export interface LevelValue {
  readonly level: SettingLevel;
  readonly value: unknown;
}

export interface Resolved {
  /** The effective value; the setting's default when no level set one. */
  readonly value: unknown;
  /** The level it came from, or null for the default. */
  readonly level: SettingLevel | null;
  /** Values left out, with why. */
  readonly ignored: readonly { level: SettingLevel; reason: string }[];
}

const rank = (l: SettingLevel) => SETTING_LEVELS.indexOf(l);

/**
 * The effective value of `s` over the levels that set it: the lowest level's value wins, as long as it does not
 * loosen the value in force above it (the default when no higher level set one). Order of `chain` does not matter.
 */
export function resolveLevels(s: SettingDescriptor, chain: readonly LevelValue[]): Resolved {
  const sorted = [...chain].sort((a, b) => rank(a.level) - rank(b.level));
  const ignored: { level: SettingLevel; reason: string }[] = [];
  let value: unknown = s.default;
  let level: SettingLevel | null = null;
  for (const c of sorted) {
    if (s.guard && c.level !== "owner") {
      ignored.push({ level: c.level, reason: `${s.key} is a guard; only the owner's reviewed config sets it` });
      continue;
    }
    // The owner's reviewed config is the root: it may set any value. Every lower level is held to the value in force.
    const why = c.level === "owner" ? null : loosens(s, c.value, value);
    if (why !== null) {
      ignored.push({ level: c.level, reason: why });
      continue;
    }
    value = c.value;
    level = c.level;
  }
  return { value, level, ignored };
}

/** Every loosening in `chain`; [] when the levels only tighten. */
export function monotonicProblems(s: SettingDescriptor, chain: readonly LevelValue[]): string[] {
  return resolveLevels(s, chain).ignored.map((i) => `${i.level}: ${i.reason}`);
}
