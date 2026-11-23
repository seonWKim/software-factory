// Skill improvement settings (design 07-self-improvement): six top-level keys of factory.config.json, config-file
// only (not settable). Absent, each takes its default; a wrong value fails the config load naming the key. The skill
// folders are capabilities.skill_folders (capabilitiesConfig), not a key of their own. The improve run reads them (src/core/skill-improve.ts).

/** Each key's default. */
export const SKILL_IMPROVE_DEFAULTS = {
  /** A score drop of more than this (0 to 1) against the skill's last run marks the skill as worse. */
  skill_improve_drop_margin: 0.05,
  /** Runs in a row with no score gain before the skill counts as stalled (integer ≥ 1). */
  skill_improve_stall_runs: 3,
  /** The pass rate (0 to 1) at which a skill needs no draft. */
  skill_improve_target: 0.9,
  /** Score changes within this (0 to 1) are noise, neither gain nor drop. */
  skill_improve_noise: 0.02,
  /** Drafts per project per UTC day (integer ≥ 0; 0 means no drafts). */
  skill_drafts_per_day: 3,
  /** Model tokens one draft may spend (integer ≥ 1). */
  skill_draft_token_budget: 50_000,
} as const;

export type SkillImproveKey = keyof typeof SKILL_IMPROVE_DEFAULTS;
export type SkillImproveConfig = { [K in SkillImproveKey]: number };

export const SKILL_IMPROVE_KEYS = Object.keys(SKILL_IMPROVE_DEFAULTS) as SkillImproveKey[];

const fraction = (v: unknown) => typeof v === "number" && v >= 0 && v <= 1;
const RULES: Record<SkillImproveKey, [check: (v: unknown) => boolean, what: string]> = {
  skill_improve_drop_margin: [fraction, "a number from 0 to 1"],
  skill_improve_noise: [fraction, "a number from 0 to 1"],
  skill_improve_target: [fraction, "a number from 0 to 1"],
  skill_improve_stall_runs: [(v) => Number.isInteger(v) && (v as number) >= 1, "an integer ≥ 1"],
  skill_draft_token_budget: [(v) => Number.isInteger(v) && (v as number) >= 1, "an integer ≥ 1"],
  skill_drafts_per_day: [(v) => Number.isInteger(v) && (v as number) >= 0, "an integer ≥ 0 (0 means no drafts)"],
};

/** One line per skill improvement key set to a wrong value, naming the key; [] when each is absent or right. */
export function skillImproveProblems(raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];
  const file = raw as Record<string, unknown>;
  return SKILL_IMPROVE_KEYS.filter((k) => file[k] !== undefined && !RULES[k][0](file[k])).map(
    (k) => `${k} must be ${RULES[k][1]} (default ${SKILL_IMPROVE_DEFAULTS[k]}); got ${JSON.stringify(file[k])}`,
  );
}

/** The six keys from a parsed factory.config.json, each absent one at its default; a wrong value throws. */
export function skillImproveConfig(raw: unknown): SkillImproveConfig {
  const problems = skillImproveProblems(raw);
  if (problems.length > 0) throw new Error(problems.join("\n"));
  const file = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<Record<SkillImproveKey, number>>;
  return Object.fromEntries(SKILL_IMPROVE_KEYS.map((k) => [k, file[k] ?? SKILL_IMPROVE_DEFAULTS[k]])) as SkillImproveConfig;
}
