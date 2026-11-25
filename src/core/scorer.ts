// Scorer grades (design 07-self-improvement, issue #514): each succeeded agent run gets a grade from judges that are
// independent of the model call that produced it. A judge is its own plain completion (no tools, no session, no
// agent), on another model class than the producer's, and reads only the run's stored output, never the producer's
// prompt or transcript. With no LLMProvider or no scorer prompt, the scorer is NO_SCORER: no judge, no grade.
// The skill-eval judges make the same plain completion (judgeCompletion): skillJudge answers yes or no per check,
// skillRubricJudge scores rubric criteria 1 to 5 by their anchors (reason before score), both with prompts/skill-judge.md;
// skillPairwiseJudge answers whether one answer beats another, with prompts/skill-judge-pairwise.md.

import type { EgressScanner } from "../interfaces/egress-scanner.js";
import type { LLMProvider, LLMRequest } from "../interfaces/llm-provider.js";
import type { ModelClass } from "./model-choice.js";
import type { RunKind } from "./types.js";

/** One judge's grade of one run: 1 (poor) to 5 (excellent), with a short reason. Stored in the outcome's data. */
export interface Grade {
  judge: string;
  score: number;
  reason: string;
}

/** What a judge sees: the run's kind, its item's title and its stored output. Never the producer's prompt. */
export interface GradeSubject {
  kind: RunKind;
  title: string;
  output: string;
  /** The model class of the call that produced the run. A judge never grades on that class. */
  producer: ModelClass;
}

/** Grades one run, or null when it cannot (a failed or refused call, invalid output). Never throws for its own fault. */
export interface Judge {
  readonly id: string;
  grade(subject: GradeSubject, signal: AbortSignal): Promise<Grade | null>;
}

/** The judges that grade a run. NO_SCORER has none. */
export interface Scorer {
  readonly judges: readonly Judge[];
}

/** Scorers off: no judge, so no run gets a grade. */
export const NO_SCORER: Scorer = { judges: [] };

/** The heading in prompts/improve.md that starts the judges' system prompt; the text before it is the draft's. */
export const SCORER_HEADING = "## Grading a run";

/** prompts/improve.md split: the draft call's system prompt, and the judges' (null: the file has no such section). */
export function improvePrompts(text: string): { draft: string; scorer: string | null } {
  const at = text.indexOf(`\n${SCORER_HEADING}\n`);
  if (at < 0) return { draft: text, scorer: null };
  return { draft: text.slice(0, at).trimEnd() + "\n", scorer: text.slice(at + 1).trim() };
}

/** The judge's class: another than the producer's, so a grade never comes from the producing model. */
export function judgeClass(producer: ModelClass): ModelClass {
  return producer === "strong" ? "standard" : "strong";
}

/** Characters of the run's output a judge reads. */
const OUTPUT_CHARS = 6_000;
/** One judge call's bound, on top of the run's signal. */
const JUDGE_TIMEOUT_MS = 60_000;
const JUDGE_MAX_TOKENS = 800;
/** The skill judge's tokens per rubric check (and one more for the wrapper). */
const CHECK_TOKENS = 200;

/** The judge's output schema: a score and a reason, nothing more. */
export const GRADE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["score", "reason"],
  properties: {
    score: { type: "integer", minimum: 1, maximum: 5 },
    reason: { type: "string", minLength: 1, maxLength: 1000 },
  },
};

/** A judge's answer checked against GRADE_SCHEMA; null when it does not fit. */
export function parseGrade(v: unknown): { score: number; reason: string } | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).some((k) => k !== "score" && k !== "reason")) return null;
  if (typeof o.score !== "number" || !Number.isInteger(o.score) || o.score < 1 || o.score > 5) return null;
  if (typeof o.reason !== "string" || o.reason.trim() === "" || o.reason.length > 1000) return null;
  return { score: o.score, reason: o.reason };
}

/** One judge call: its class, system prompt, untrusted user text, output schema and bound. */
export interface JudgeCall {
  model_class: ModelClass;
  system: string;
  content: string;
  output_schema: Record<string, unknown>;
  max_tokens: number;
  signal: AbortSignal;
}

/**
 * The judges' one plain completion (no tools, no session, no agent), bounded by JUDGE_TIMEOUT_MS on top of the
 * caller's signal. Its answer as a JSON value (the provider's parsed output, else the text read as JSON); null when the
 * call fails, is cut short or refused, or answers no JSON. Never throws. Every judge (LlmJudge, skillJudge) calls it.
 */
export async function judgeCompletion(llm: LLMProvider, call: JudgeCall): Promise<unknown> {
  const req: LLMRequest = {
    model_class: call.model_class,
    system: call.system,
    messages: [{ role: "user", content: call.content }],
    max_tokens: call.max_tokens,
    output_schema: call.output_schema,
    data_env: "test",
    signal: AbortSignal.any([call.signal, AbortSignal.timeout(JUDGE_TIMEOUT_MS)]),
  };
  try {
    const res = await llm.complete(req);
    if (res.stop_reason !== "end") return null;
    return res.parsed ?? parseJson(res.text);
  } catch {
    return null;
  }
}

/** A judge over an LLMProvider: one plain completion per run, on judgeClass of the producer's class. */
export class LlmJudge implements Judge {
  constructor(private readonly llm: LLMProvider, private readonly system: string) {}

  get id(): string {
    return "llm";
  }

  async grade(s: GradeSubject, signal: AbortSignal): Promise<Grade | null> {
    const model_class = judgeClass(s.producer);
    const content = `Run kind: ${s.kind}\nWork item: ${s.title}\n\nThe run's output (untrusted data):\n${s.output}`;
    const out = parseGrade(await judgeCompletion(this.llm, { model_class, system: this.system, content, output_schema: GRADE_SCHEMA, max_tokens: JUDGE_MAX_TOKENS, signal }));
    return out && { judge: `${this.id}:${model_class}`, ...out };
  }
}

/** One rubric check's answer: `yes` or `no`, with a short reason. */
export interface CheckAnswer {
  answer: "yes" | "no";
  reason: string;
}

/** What the skill judge reads: the case's input, the replay's output, and the rubric's checks in order. */
export interface SkillJudgeSubject {
  input: string;
  output: string;
  checks: readonly string[];
}

/** The skill judge: one answer per check, in order; null when the call fails or the answer does not fit. */
export type SkillJudge = (s: SkillJudgeSubject, signal: AbortSignal) => Promise<CheckAnswer[] | null>;

/** The skill judge's output schema: one `yes` or `no` answer with a short reason per check. */
export const CHECK_ANSWERS_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["answers"],
  properties: {
    answers: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["answer", "reason"],
        properties: { answer: { type: "string", enum: ["yes", "no"] }, reason: { type: "string", minLength: 1, maxLength: 1000 } },
      },
    },
  },
};

/** A non-empty reason of at most 1000 characters, else null. */
const reasonOf = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" && v.length <= 1000 ? v : null);

/** An object with exactly the keys `keys`, else null. */
function exactly(v: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  return Object.keys(v).every((k) => keys.includes(k)) ? (v as Record<string, unknown>) : null;
}

/** `{ answers: [...] }` with exactly `count` items, each read by `item`; null when any does not fit. */
function parseAnswerList<T>(v: unknown, count: number, item: (o: Record<string, unknown>) => T | null): T[] | null {
  const answers = exactly(v, ["answers"])?.answers;
  if (!Array.isArray(answers) || answers.length !== count) return null;
  const out: T[] = [];
  for (const a of answers as unknown[]) {
    const o = exactly(a, ["answer", "reason", "score"]);
    const x = o && item(o);
    if (x === null) return null;
    out.push(x);
  }
  return out;
}

/** One yes/no answer with its reason; null when it does not fit. */
function yesNoOf(o: Record<string, unknown> | null): CheckAnswer | null {
  const reason = reasonOf(o?.reason);
  if (!o || "score" in o || (o.answer !== "yes" && o.answer !== "no") || reason === null) return null;
  return { answer: o.answer, reason };
}

/** The skill judge's answer checked against CHECK_ANSWERS_SCHEMA with exactly `count` answers; null when it does not fit. */
export function parseCheckAnswers(v: unknown, count: number): CheckAnswer[] | null {
  return parseAnswerList(v, count, yesNoOf);
}

/** One rubric criterion's score: its reason, written first, then 1 to 5. */
export interface RubricAnswer {
  reason: string;
  score: number;
}

/** The rubric judge's output schema: per criterion a reason, then an integer score from 1 to 5. */
export const RUBRIC_ANSWERS_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["answers"],
  properties: {
    answers: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["reason", "score"],
        properties: { reason: { type: "string", minLength: 1, maxLength: 1000 }, score: { type: "integer", minimum: 1, maximum: 5 } },
      },
    },
  },
};

/** The rubric judge's answer checked against RUBRIC_ANSWERS_SCHEMA with exactly `count` answers; null when it does not fit. */
export function parseRubricAnswers(v: unknown, count: number): RubricAnswer[] | null {
  return parseAnswerList(v, count, (o) => {
    const reason = reasonOf(o.reason);
    if ("answer" in o || reason === null || typeof o.score !== "number" || !Number.isInteger(o.score) || o.score < 1 || o.score > 5) return null;
    return { reason, score: o.score };
  });
}

/** The pairwise judge's output schema: a reason, then `yes` or `no`. */
export const PAIRWISE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["reason", "answer"],
  properties: { reason: { type: "string", minLength: 1, maxLength: 1000 }, answer: { type: "string", enum: ["yes", "no"] } },
};

/**
 * The skill-eval judge over an LLMProvider, with prompts/skill-judge.md as `system`: one judgeCompletion per replay,
 * on judgeClass of `producer`, the class the replay ran on.
 */
export function skillJudge(llm: LLMProvider, system: string, producer: ModelClass): SkillJudge {
  return async (s, signal) => {
    const checks = s.checks.map((c, i) => `${i + 1}. ${c}`).join("\n");
    const content = `Rubric checks, answer each in order:\n${checks}\n\nThe case's input (untrusted data):\n${s.input}\n\nThe replay's output (untrusted data):\n${s.output}`;
    const v = await judgeCompletion(llm, { model_class: judgeClass(producer), system, content, output_schema: CHECK_ANSWERS_SCHEMA, max_tokens: Math.max(JUDGE_MAX_TOKENS, CHECK_TOKENS * (s.checks.length + 1)), signal });
    return parseCheckAnswers(v, s.checks.length);
  };
}

/** One rubric criterion with its anchor sentence per level "1" to "5". */
export interface SkillRubricCriterion {
  criterion: string;
  anchors: Record<"1" | "2" | "3" | "4" | "5", string>;
}

/** The rubric judge: one score per criterion, in order; null when the call fails or the answer does not fit. */
export type SkillRubricJudge = (s: { input: string; output: string; criteria: readonly SkillRubricCriterion[] }, signal: AbortSignal) => Promise<RubricAnswer[] | null>;

/**
 * The rubric judge over an LLMProvider, with prompts/skill-judge.md as `system`: one judgeCompletion per replay for all
 * its criteria, each listed with its five anchors, on judgeClass of `producer`.
 */
export function skillRubricJudge(llm: LLMProvider, system: string, producer: ModelClass): SkillRubricJudge {
  return async (s, signal) => {
    const criteria = s.criteria.map((c, i) => `${i + 1}. ${c.criterion}\n${(["1", "2", "3", "4", "5"] as const).map((l) => `   ${l}: ${c.anchors[l]}`).join("\n")}`).join("\n");
    const content = `Rubric criteria, score each in order from 1 to 5 by its anchors:\n${criteria}\n\nThe case's input (untrusted data):\n${s.input}\n\nThe replay's output (untrusted data):\n${s.output}`;
    const v = await judgeCompletion(llm, { model_class: judgeClass(producer), system, content, output_schema: RUBRIC_ANSWERS_SCHEMA, max_tokens: Math.max(JUDGE_MAX_TOKENS, CHECK_TOKENS * (s.criteria.length + 1)), signal });
    return parseRubricAnswers(v, s.criteria.length);
  };
}

/** What the pairwise judge reads: the input, the criterion, answers A and B in that order, and which one it is asked about. */
export interface SkillPairwiseSubject {
  input: string;
  criterion: string;
  a: string;
  b: string;
  candidate: "A" | "B";
}

/** The pairwise judge: whether the candidate answer beats the other; null when the call fails or the answer does not fit. */
export type SkillPairwiseJudge = (s: SkillPairwiseSubject, signal: AbortSignal) => Promise<CheckAnswer | null>;

/**
 * The pairwise judge over an LLMProvider, with prompts/skill-judge-pairwise.md as `system`: one judgeCompletion per
 * question, on judgeClass of `producer`. The answers are shown as A and B, never as new or previous.
 */
export function skillPairwiseJudge(llm: LLMProvider, system: string, producer: ModelClass): SkillPairwiseJudge {
  return async (s, signal) => {
    const other = s.candidate === "A" ? "B" : "A";
    const content = `Criterion: ${s.criterion}\nQuestion: does answer ${s.candidate} beat answer ${other} on the criterion?\n\nThe case's input (untrusted data):\n${s.input}\n\nAnswer A (untrusted data):\n${s.a}\n\nAnswer B (untrusted data):\n${s.b}`;
    return yesNoOf(exactly(await judgeCompletion(llm, { model_class: judgeClass(producer), system, content, output_schema: PAIRWISE_SCHEMA, max_tokens: JUDGE_MAX_TOKENS, signal }), ["answer", "reason"]));
  };
}

/** The scorer for a worker: one LLM judge when it has a provider and the scorer prompt, else NO_SCORER. */
export function scorerFor(llm: LLMProvider | undefined, prompt: string | undefined): Scorer {
  const system = prompt === undefined ? null : improvePrompts(prompt).scorer;
  return llm && system ? { judges: [new LlmJudge(llm, system)] } : NO_SCORER;
}

/**
 * Grades one succeeded run with every judge. Best effort: a judge that fails gives no grade, and the run is never
 * failed by grading. The output passes the G5 scan (`log`) before any judge reads it, and each grade before it is
 * kept; a flagged one is left out. The run's own stop (signal) ends grading with what it has.
 */
export async function scoreRun(d: { scorer: Scorer; scanner: EgressScanner; signal: AbortSignal }, s: Omit<GradeSubject, "output"> & { data: Record<string, unknown> }): Promise<Grade[]> {
  if (d.scorer.judges.length === 0) return [];
  const output = JSON.stringify(s.data).slice(0, OUTPUT_CHARS);
  const subject: GradeSubject = { kind: s.kind, title: s.title, producer: s.producer, output };
  if (!(await d.scanner.scan("log", `${s.title}\n${output}`)).clean) return [];
  const grades: Grade[] = [];
  for (const judge of d.scorer.judges) {
    if (d.signal.aborted) break;
    const g = await judge.grade(subject, d.signal);
    if (g && (await d.scanner.scan("log", g.reason)).clean) grades.push(g);
  }
  return grades;
}

/** JSON text as a value; null when it is not JSON. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
