// Judge calibration (design 06-measurement, judge labels): how often the owner agrees with the skill-eval judge. Pure:
// the caller reads a skill's labels from the store (listSkillEvalLabels) and passes them in. Self-improve
// (src/core/skill-improve.ts) drafts nothing for a skill that is not calibrated.

import type { SkillEvalLabel } from "../interfaces/skill-eval-store.js";

/** The lowest judge agreement at which a skill's eval results are trusted for drafting. One constant, no setting. */
export const CALIBRATION_THRESHOLD = 0.8;

/** Right labels ÷ all labels of one skill; null with no labels (no agreement). */
export function judgeAgreement(labels: readonly Pick<SkillEvalLabel, "verdict">[]): number | null {
  return labels.length === 0 ? null : labels.filter((l) => l.verdict === "right").length / labels.length;
}

/** Whether the skill's judge is calibrated: it has labels and agreement at or above CALIBRATION_THRESHOLD. */
export function judgeCalibrated(labels: readonly Pick<SkillEvalLabel, "verdict">[]): boolean {
  const agreement = judgeAgreement(labels);
  return agreement !== null && agreement >= CALIBRATION_THRESHOLD - 1e-9;
}
