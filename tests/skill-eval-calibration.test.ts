// Judge calibration (design 06-measurement, judge labels; src/core/skill-eval-calibration.ts): agreement is right
// labels ÷ all labels of a skill, none with no labels, and a skill is calibrated at 80% or more.

import { describe, expect, it } from "vitest";
import { CALIBRATION_THRESHOLD, judgeAgreement, judgeCalibrated } from "../src/core/skill-eval-calibration.js";
import type { SkillEvalLabelVerdict } from "../src/interfaces/skill-eval-store.js";

const labels = (right: number, wrong: number) =>
  [...Array<SkillEvalLabelVerdict>(right).fill("right"), ...Array<SkillEvalLabelVerdict>(wrong).fill("wrong")].map((verdict) => ({ verdict }));

describe("judgeAgreement", () => {
  it("is right labels divided by all labels", () => {
    expect(judgeAgreement(labels(3, 1))).toBe(0.75);
    expect(judgeAgreement(labels(1, 0))).toBe(1);
    expect(judgeAgreement(labels(0, 2))).toBe(0);
  });

  it("is null with no labels: no agreement", () => {
    expect(judgeAgreement([])).toBeNull();
  });
});

describe("judgeCalibrated", () => {
  it("the threshold is 80%", () => {
    expect(CALIBRATION_THRESHOLD).toBe(0.8);
  });

  it("is false with no labels or agreement below 80%, true at 80% or more", () => {
    expect(judgeCalibrated([])).toBe(false);
    expect(judgeCalibrated(labels(3, 1))).toBe(false);
    expect(judgeCalibrated(labels(4, 1))).toBe(true);
    expect(judgeCalibrated(labels(5, 0))).toBe(true);
  });
});
