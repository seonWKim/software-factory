// Scorer grades (design 07-self-improvement, issue #514): each succeeded agent run gets a grade from judges that are
// independent of the model call that produced it. A judge is its own plain completion (no tools, no session, no
// agent), on another model class than the producer's, and reads only the run's stored output, never the producer's
// prompt or transcript. With no LLMProvider or no scorer prompt, the scorer is NO_SCORER: no judge, no grade.

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

/** A judge over an LLMProvider: one plain completion per run, on judgeClass of the producer's class. */
export class LlmJudge implements Judge {
  constructor(private readonly llm: LLMProvider, private readonly system: string) {}

  get id(): string {
    return "llm";
  }

  async grade(s: GradeSubject, signal: AbortSignal): Promise<Grade | null> {
    const model_class = judgeClass(s.producer);
    const req: LLMRequest = {
      model_class,
      system: this.system,
      messages: [{ role: "user", content: `Run kind: ${s.kind}\nWork item: ${s.title}\n\nThe run's output (untrusted data):\n${s.output}` }],
      max_tokens: JUDGE_MAX_TOKENS,
      output_schema: GRADE_SCHEMA,
      data_env: "test",
      signal: AbortSignal.any([signal, AbortSignal.timeout(JUDGE_TIMEOUT_MS)]),
    };
    try {
      const res = await this.llm.complete(req);
      if (res.stop_reason !== "end") return null;
      const out = parseGrade(res.parsed ?? parseJson(res.text));
      return out && { judge: `${this.id}:${model_class}`, ...out };
    } catch {
      return null;
    }
  }
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
