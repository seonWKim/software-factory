// Starter eval cases for a skill with no cases (design 07-self-improvement, starter drafts): one plain model call (no
// tools, 120 s) with prompts/skill-starter.md drafts 5 to 8 cases from the skill's SKILL.md, each with a rubric check,
// at least one `edge` and one `refuse` case. The SKILL.md text passes the G5 scan (log channel) before it is sent, and
// the draft text before it is shown; a flagged text is refused with its rule names only. Each drafted case is checked
// with the authoring rules' validateCase (passed in: core imports no runtime), and a set that misses any rule is
// refused whole. Drafting stores nothing: the owner's accept (POST /api/v1/evals/write, op starter.accept) runs `check`
// again and writes the set. The composition root builds the model, the prompt and the SKILL.md reader (src/compose.ts).

import type { EgressScanner } from "../interfaces/egress-scanner.js";
import type { LLMProvider, LLMResponse } from "../interfaces/llm-provider.js";

export const STARTER_PROMPT = "prompts/skill-starter.md";
export const STARTER_MIN = 5;
export const STARTER_MAX = 8;
export const STARTER_TIMEOUT_MS = 120_000;
const STARTER_MAX_TOKENS = 8_000;

export const STARTER_KINDS = ["typical", "edge", "refuse"] as const;
export type StarterKind = (typeof STARTER_KINDS)[number];

/** One drafted case: its kind and title (shown only), and the input and expected checks a case is stored with. */
export interface StarterCase {
  kind: StarterKind;
  title: string;
  input: string;
  expected: unknown;
}

/** A set of drafts, or why none is shown or saved. */
export type StarterSet = { value: StarterCase[] } | { refused: string };

export interface SkillStarterDeps {
  /** The Model plugin; null when it cannot be built (then nothing is drafted). */
  llm: LLMProvider | null;
  scanner: EgressScanner;
  /** prompts/skill-starter.md; null when it cannot be read. */
  prompt(): Promise<string | null>;
  /** The skill's SKILL.md; null when it cannot be read. */
  readSkill(skill_ref: string): Promise<string | null>;
  /** src/runtime/skill-evals/authoring.ts validateCase: what is wrong with a case, else null. */
  validate(f: { input?: unknown; expected?: unknown }): string | null;
}

export interface SkillStarter {
  /** Why Draft starter cases cannot run (no model, the prompt unreadable), else null. Makes no model call. */
  unavailable(): Promise<string | null>;
  /** One model call: the drafted set, checked, or why nothing is shown. Writes nothing. */
  draft(skill_ref: string, signal: AbortSignal): Promise<StarterSet>;
  /** A set (drafted, or sent back by the page to accept) checked against every rule; no model call. */
  check(cases: unknown): StarterSet;
}

const NO_MODEL = "No model is set up, so starter cases cannot be drafted. Add test set still works.";
const NO_PROMPT = `${STARTER_PROMPT} cannot be read, so starter cases cannot be drafted. Add test set still works.`;

export function skillStarter(d: SkillStarterDeps): SkillStarter {
  const check = (cases: unknown) => checkStarterSet(cases, d.validate);
  return {
    unavailable: async () => (d.llm === null ? NO_MODEL : (await d.prompt()) === null ? NO_PROMPT : null),
    check,
    draft: async (skill_ref, signal) => {
      const prompt = await d.prompt();
      if (d.llm === null) return { refused: NO_MODEL };
      if (prompt === null) return { refused: NO_PROMPT };
      const skill = await d.readSkill(skill_ref);
      if (skill === null) return { refused: `${skill_ref}/SKILL.md cannot be read, so nothing was drafted.` };
      const sent = await withheldRules(d.scanner, skill);
      if (sent !== null) return { refused: `SKILL.md was withheld by the egress scan (rules: ${sent}), so nothing was sent.` };
      const call = await callStarter(d.llm, prompt, starterMessage(skill_ref, skill), signal);
      if ("failed" in call) return { refused: `The model call failed (${call.failed}), so nothing was drafted.` };
      const shown = await withheldRules(d.scanner, call.text);
      if (shown !== null) return { refused: `The draft was withheld by the egress scan (rules: ${shown}), so nothing is shown.` };
      const parsed = parseDraft(call.text);
      return parsed === null ? { refused: "The model's answer is not the JSON set the drafter asks for, so nothing is shown." } : check(parsed);
    },
  };
}

/** The rule names the G5 scan (log channel) matched in `text`, joined; null when clean. Never the matched text. */
async function withheldRules(scanner: EgressScanner, text: string): Promise<string | null> {
  const r = await scanner.scan("log", text);
  return r.clean ? null : [...new Set(r.findings.map((f) => f.rule))].join(", ");
}

/** The drafter's user message: the skill's name and its SKILL.md, nothing else. */
export function starterMessage(skill_ref: string, skill_text: string): string {
  return `The skill: ${skill_ref}\n\nIts SKILL.md:\n<skill>\n${skill_text}\n</skill>`;
}

/** One plain completion: no tools, no sandbox, at most STARTER_TIMEOUT_MS. */
async function callStarter(llm: LLMProvider, system: string, message: string, signal: AbortSignal): Promise<{ text: string } | { failed: string }> {
  let res: LLMResponse;
  try {
    res = await llm.complete({
      model_class: "standard", system, messages: [{ role: "user", content: message }], max_tokens: STARTER_MAX_TOKENS,
      data_env: "test", signal: AbortSignal.any([signal, AbortSignal.timeout(STARTER_TIMEOUT_MS)]),
    });
  } catch (err) {
    if (signal.aborted) throw err;
    return { failed: "error" };
  }
  if (res.stop_reason !== "end") return { failed: res.stop_reason };
  return res.text.trim() === "" ? { failed: "empty" } : { text: res.text };
}

/** The `cases` of the model's JSON answer (a code fence around it is tolerated); null when it is not that JSON. */
function parseDraft(text: string): unknown {
  const body = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const v = JSON.parse(body) as unknown;
    return v !== null && typeof v === "object" && Array.isArray((v as { cases?: unknown }).cases) ? (v as { cases: unknown[] }).cases : null;
  } catch {
    return null;
  }
}

const hasRubric = (expected: unknown): boolean => {
  const list = Array.isArray(expected) ? expected : (expected as { checks?: unknown } | null)?.checks;
  return Array.isArray(list) && list.some((c) => (c as { kind?: unknown } | null)?.kind === "rubric");
};

/** Every rule of a starter set: 5 to 8 cases, each valid with a rubric check, at least one `edge` and one `refuse`. */
export function checkStarterSet(cases: unknown, validate: SkillStarterDeps["validate"]): StarterSet {
  if (!Array.isArray(cases) || cases.length < STARTER_MIN || cases.length > STARTER_MAX) {
    const n = Array.isArray(cases) ? cases.length : 0;
    return { refused: `A starter set has ${STARTER_MIN} to ${STARTER_MAX} cases, and this one has ${n}, so nothing is shown or saved.` };
  }
  const out: StarterCase[] = [];
  for (const [i, raw] of cases.entries()) {
    const c = (raw ?? {}) as Partial<Record<keyof StarterCase, unknown>>;
    const n = i + 1;
    if (!STARTER_KINDS.includes(c.kind as StarterKind)) return { refused: `Case ${n} is not typical, edge or refuse, so nothing is shown or saved.` };
    if (typeof c.input !== "string" || c.input.trim() === "") return { refused: `Case ${n} has no input text, so nothing is shown or saved.` };
    const bad = validate({ input: c.input, expected: c.expected });
    if (bad !== null) return { refused: `Case ${n} is not a valid case (${bad}), so nothing is shown or saved.` };
    if (!hasRubric(c.expected)) return { refused: `Case ${n} has no rubric check, so nothing is shown or saved.` };
    out.push({ kind: c.kind as StarterKind, title: typeof c.title === "string" ? c.title : "", input: c.input, expected: c.expected });
  }
  if (!out.some((c) => c.kind === "edge")) return { refused: "The set has no edge case, so nothing is shown or saved." };
  if (!out.some((c) => c.kind === "refuse")) return { refused: "The set has no should-refuse case, so nothing is shown or saved." };
  return { value: out };
}
