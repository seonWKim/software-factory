// SkillEvalSource (design 06-measurement, docs/plugins/skill-eval-source.md): where `factory eval import <skill>`
// reads a skill's eval cases from. Read only: nothing here writes to the source, so an edit of an imported case stays
// in the factory's store. Selected by `plugins.eval_source`; `none` (also when the key is left out) is no source.

/** One case as the source holds it: its id there, its input, and its expected value (rubric check texts). */
export interface SkillEvalSourceCase {
  readonly id: string;
  readonly input: unknown;
  readonly expected: unknown;
}

/** A source that cannot be read (its home or CLI is missing, the CLI failed): import refuses and writes nothing. */
export class SkillEvalSourceUnavailable extends Error {}

export interface SkillEvalSource {
  /** False for `none`: no source is on, and import refuses. */
  readonly enabled: boolean;
  /** The skill's cases at the source, read only. Throws SkillEvalSourceUnavailable when the source cannot be read. */
  listCases(skill: string): Promise<readonly SkillEvalSourceCase[]>;
}
