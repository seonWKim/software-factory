import type { SkillEvalSource, SkillEvalSourceCase } from "../../interfaces/skill-eval-source.js";

/** `none`: no eval source is on; `factory eval import` refuses. */
export class NoEvalSource implements SkillEvalSource {
  readonly enabled = false;

  async listCases(): Promise<readonly SkillEvalSourceCase[]> {
    return [];
  }
}
