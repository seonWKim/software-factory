import { DONE_CHECKS_SCHEMA, type DoneCheck, parseDoneChecks } from "./done-checks.js";
import { isCovered } from "./policy.js";
import { MAX_PHASES, MIN_PHASES, type SplitLimits, parseGoalLines, splitError } from "./split.js";
import { DEPENDENCY_OPTIONS, proposedDependency } from "./task-build.js";
import type { Tier } from "./types.js";
export { checkTestFiles, doneCheckCommands } from "./done-checks.js"; export { sizeCaps } from "./size-cap.js"; export { pinTests, removedPins } from "./triage-pins.js"; // the triage branch's check_commands, test file check and pinned tests (removedPins: the checks grant's); an item's size caps for the implement run

// Structured outputs of each agent role: JSON Schema for the harness + a validator for the control plane.
// Agents can be wrong; nothing they return is trusted until it passes these.

export interface TriageOutput {
  /** Plain AS-IS → TO-BE statement that opens the spec comment; no file-level detail. Not stored. */
  in_short: string;
  problem: string;
  done_criteria: string[];
  done_checks?: DoneCheck[]; // one check per done-when line, in order (design 04-triage, 2026-11-22); absent on an older answer or a session's spec without one
  desired_output: string;
  /** In and out of scope as one text: the stored `scope`, from `in_scope` and `out_of_scope` (issue #229), else an older output's own `scope`. */
  scope: string;
  /** In-scope items, one per entry. Absent on an older output, which has only `scope`. */
  in_scope?: string[];
  /** Out-of-scope items, one per entry. Absent on an older output. */
  out_of_scope?: string[];
  /** Decisions the human must make before approving (at most 5 shown), one line each as the spec comment shows it. Optional; the validator defaults it to []. */
  decisions?: string[];
  /** The same decisions with their proposed default and owner-only flag (issue #444), for auto mode. [] when none. */
  decision_items?: SpecDecision[];
  /** Owner defaults triage applied instead of asking (issue #315), one rule per entry. Optional; the validator defaults it to []. */
  applied_defaults?: string[];
  allowed_paths: string[];
  /** Every file or directory the done criteria create or edit; each must be covered by `allowed_paths`. `pinned_tests`: those of them a base test file the spec quotes (design 04-triage, 2026-11-25); absent when none. */
  files_to_change: string[]; pinned_tests?: string[];
  tier: Tier;
  tier_reason: string;
  /** Triage's estimate of the diff, before any code change (design 2026-11-01): added plus deleted lines. */
  estimated_lines: number;
  /** Triage's estimate of the number of changed files. */
  estimated_files: number;
  /** A split into 2 to 4 ordered phases, each mergeable on its own: required over the split threshold (src/core/split.ts), else absent. */
  phases?: TriagePhase[];
  goal_done_when?: string[]; // a split's goal lines, in order (design 04-split-specs, 2026-11-22); only with phases
}

/**
 * One triage decision (issue #444): the question, the proposed default, and whether only the owner may answer it (auto mode approves
 * with each default unless one is). A plain-text decision, or one with no flag or no default, is owner-only. Reason and options: issue #526.
 */
export interface SpecDecision {
  /** The question. Triage writes it as `question`; the stored decision keeps the name `text`. */
  text: string;
  default: string | null;
  owner_only: boolean;
  reason?: string;
  /** The answers to pick from, the default among them; absent or empty for a free answer. */
  options?: string[];
  /** What picking an option changes (design 04-triage, 2026-11-21), one entry per option that changes any; absent when none (and on an older decision). */
  option_changes?: OptionChange[];
  layout?: boolean; // a layout decision: each option is a text sketch of a page, shown in monospace
}

/** One option's changes to the spec: the paths it needs beyond allowed_paths, and the done-when lines it changes. */
export type OptionChange = { option: string; extra_paths: string[]; done_when: string[] };

/** The changes of the option `answer` picks on decision `d`, or null when it changes nothing (or is no option). */
export const optionChange = (d: Pick<SpecDecision, "option_changes">, answer: string | null): OptionChange | null =>
  d.option_changes?.find((c) => c.option === answer) ?? null;

/** How many options a decision with options offers (issue #526); a decision may also have none. */
export const MIN_OPTIONS = 2, MAX_OPTIONS = 4, MAX_LAYOUT_OPTIONS = 3; // a layout decision offers MIN_OPTIONS to MAX_LAYOUT_OPTIONS

/** One phase of a split spec. On /approve it becomes a sub-issue and then an ordinary work item. */
export interface TriagePhase {
  title: string;
  problem: string;
  done_criteria: string[];
  allowed_paths: string[];
}

/**
 * An agent's "I cannot go on without a human" answer (implement, resolve and review): why, and the one question the owner should
 * answer, each at most NEEDS_HUMAN_MAX_CHARS. Not a failure: the controller blocks the item with `agent_needs_human`, no retry.
 */
export interface NeedsHuman {
  reason: string;
  question: string;
  /** Implement only (issue #280): paths needed outside the allowed paths, shown as the `/retry +paths ...` reply, never applied. Absent when none. */
  paths?: string[];
}

/** The longest `needs_human.reason` or `needs_human.question` the validators accept. */
export const NEEDS_HUMAN_MAX_CHARS = 500;
/** The most `needs_human.paths` the validators accept: one `/retry +paths` reply's worth. */
export const NEEDS_HUMAN_MAX_PATHS = 10;

export interface ImplementOutput {
  /** "" when the agent returned needs_human or spec_conflict without it. */
  summary: string;
  /** "" when the agent returned needs_human or spec_conflict without it. */
  next_steps: string;
  /** Work the spec asks for that this change does not do, one entry each (issue #229). Non-empty marks the PR incomplete. [] when absent. */
  missing: string[];
  /** Where the change differs from the spec on purpose, one entry each. [] when absent. */
  deviations: string[];
  needs_human?: NeedsHuman;
  /** A done criterion that cannot be met inside the spec (issue #222): the run fails with it and a spec revision starts. Absent when empty. */
  spec_conflict?: string;
  /** The work was already on the base: the passing checks named. Read only with no commits (design 04-pre-push-gates). */ already_done?: string;
}
export const ALREADY_DONE_MAX_CHARS = 500;

/** Entries kept per `missing` / `deviations` list, and characters per entry. */
export const PR_NOTE_MAX_ITEMS = 10;
export const PR_NOTE_MAX_CHARS = 300;

/** The error code of an implement run whose agent returned a `spec_conflict`; its detail is the reason. */
export const SPEC_CONFLICT = "spec_conflict";

/** The longest `spec_conflict` reason the validator accepts: what a failed run's detail keeps. */
export const SPEC_CONFLICT_MAX_CHARS = 500;

/** One reviewer finding (issue #222): `code`, a defect fixable inside the spec; `spec`, one that needs the spec changed (a file outside the allowed paths, a criterion against a repo rule). */
export type ReviewFinding = { kind: "code" | "spec"; text: string };

export interface ReviewOutput {
  verdict: "pass" | "bug";
  tier: Tier;
  findings: ReviewFinding[];
  /** Checks the reviewer could not run (e.g. the tests in its sandbox). Never a finding. Left out when empty; read it with `unverifiedOf`. */
  unverified?: string[];
  /** A UI change whose build, type-check or screenshots could not run: header "needs a human look", no auto merge. Left out when unset. */
  ui_unverified?: boolean;
  /** Done-when lines built differently, each with its reason from the work item (design 04-agents). Left out when empty. */
  built_differently?: BuiltDifferently[];
  unconfirmed?: ReviewFinding[]; // findings their confirm run did not confirm (design 04-agents): stored, never routed; left out when empty
  summary: string;
  needs_human?: NeedsHuman;
}

/** A done-when line the change builds differently, and the reason the work item gives for it. */
export type BuiltDifferently = { line: string; reason: string };

/** The review's done-when lines built differently; [] when it has none. */
export const builtDifferentlyOf = (r: Pick<ReviewOutput, "built_differently">): BuiltDifferently[] => r.built_differently ?? [];

/** The review's unverified checks; [] when it has none. */
export const unverifiedOf = (r: Pick<ReviewOutput, "unverified">): string[] => r.unverified ?? [];

export const BUILT_DIFFERENTLY_FINDING = "built differently from the spec with no reason in the work item: "; // the factory's own code finding for such a line
/** The findings that need the spec changed. */
export const specFindings = (r: Pick<ReviewOutput, "findings">): ReviewFinding[] => r.findings.filter((f) => f.kind === "spec");

/** A finding as one line of text: a spec finding says so. */
export const findingLine = (f: ReviewFinding): string => (f.kind === "spec" ? `(spec) ${f.text}` : f.text);

const tierSchema = { type: "integer", minimum: 1, maximum: 5 };
const strings = { type: "array", items: { type: "string" } };
const count = { type: "integer", minimum: 0 };
/** A closed object schema whose every property is required. */
const closed = (properties: Record<string, unknown>) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });

/** The most "Decisions for you" lines a spec shows (issue #229). */
export const MAX_DECISIONS = 5;

/** The most applied owner defaults a triage answer may list (issue #315). */
export const MAX_APPLIED_DEFAULTS = 10;

/** The stored `scope` text for separate in-scope and out-of-scope lists. */
export function scopeText(inScope: readonly string[], outOfScope: readonly string[]): string {
  const list = (xs: readonly string[]) => (xs.length > 0 ? xs.map((x) => `- ${x}`) : ["- (none)"]);
  return ["In scope:", ...list(inScope), "", "Out of scope:", ...list(outOfScope)].join("\n");
}

export const TRIAGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "in_short", "problem", "done_criteria", "desired_output", "in_scope", "out_of_scope", "allowed_paths",
    "files_to_change", "tier", "tier_reason", "estimated_lines", "estimated_files", "done_checks",
  ],
  properties: {
    in_short: { type: "string" },
    problem: { type: "string" },
    done_criteria: { ...strings, minItems: 1 }, done_checks: DONE_CHECKS_SCHEMA,
    decisions: {
      type: "array",
      maxItems: MAX_DECISIONS,
      items: closed({
          question: { type: "string", description: "The question, in one line." },
          reason: { type: "string", description: "Why you ask: what the answer changes." },
          options: { ...strings, maxItems: MAX_OPTIONS, description: `[] for a free answer, or ${MIN_OPTIONS} to ${MAX_OPTIONS} answers to pick from.` },
          default: { type: "string", description: "The answer you propose, one of the options when there are any; the factory takes it when it approves on its own." },
          owner_only: { type: "boolean", description: "true when only the owner may answer: no default fits, or the choice is risky." },
          option_changes: { type: "array", maxItems: MAX_OPTIONS, description: "[] when no option changes the spec. Otherwise one entry per option that does: the paths it needs outside allowed_paths and the done-when lines it changes.", items: closed({
              option: { type: "string", description: "One of the options, as written there." },
              extra_paths: { ...strings, description: "Repo-relative paths this option needs that allowed_paths does not cover. [] when none." },
              done_when: { ...strings, description: "The done-when lines this option changes, each as the line it becomes. [] when none." } }) },
          layout: { type: "boolean", description: `true only for a layout decision: ${MIN_OPTIONS} to ${MAX_LAYOUT_OPTIONS} options, each a text sketch of the page.` },
      }),
    },
    applied_defaults: { ...strings, maxItems: MAX_APPLIED_DEFAULTS },
    desired_output: { type: "string" },
    in_scope: strings,
    out_of_scope: strings,
    allowed_paths: { ...strings, minItems: 1 },
    files_to_change: strings,
    tier: tierSchema,
    tier_reason: { type: "string" },
    estimated_lines: count,
    estimated_files: count,
    phases: { type: "array", maxItems: MAX_PHASES, items: closed({ title: { type: "string" }, problem: { type: "string" }, done_criteria: { ...strings, minItems: 1 }, allowed_paths: { ...strings, minItems: 1 } }) },
    goal_done_when: { ...strings, description: "Only with phases: what the whole split must do once every phase merged, one line each." },
  },
};

const NEEDS_HUMAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reason", "question"],
  description:
    "Only when you cannot go on without a human (missing credentials or permissions, a tool that fails the same way twice, " +
    "a spec that contradicts the code, a decision only the owner can make). Never for a bug you can fix.",
  properties: {
    reason: { type: "string", maxLength: NEEDS_HUMAN_MAX_CHARS, description: "Why you stopped, in one or two plain sentences." },
    question: { type: "string", maxLength: NEEDS_HUMAN_MAX_CHARS, description: "The one question the owner should answer." },
  },
};

/** The implementer's needs_human: also the paths outside the allowed paths it needs, for the owner to allow (issue #280). */
const IMPLEMENT_NEEDS_HUMAN_SCHEMA = {
  ...NEEDS_HUMAN_SCHEMA,
  properties: {
    ...NEEDS_HUMAN_SCHEMA.properties,
    paths: {
      type: "array",
      maxItems: NEEDS_HUMAN_MAX_PATHS,
      items: { type: "string", maxLength: NEEDS_HUMAN_MAX_CHARS },
      description: "Only when the work needs files outside the allowed paths: those repo-relative paths, so the owner can allow them. They change nothing by themselves.",
    },
  },
};

// summary and next_steps are not schema-required: they may be left out when needs_human or spec_conflict is set.
// parseImplement still requires both on every other answer.
export const IMPLEMENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [],
  properties: {
    summary: { type: "string", description: "Required unless needs_human or spec_conflict is set." },
    next_steps: { type: "string", description: "Required unless needs_human or spec_conflict is set." },
    missing: {
      type: "array",
      maxItems: PR_NOTE_MAX_ITEMS,
      items: { type: "string", maxLength: PR_NOTE_MAX_CHARS },
      description: "Work the spec asks for that this change does not do (for example a needed file outside the allowed paths). Empty or absent when the work is complete.",
    },
    deviations: {
      type: "array",
      maxItems: PR_NOTE_MAX_ITEMS,
      items: { type: "string", maxLength: PR_NOTE_MAX_CHARS },
      description: "Where the change differs from the spec on purpose. Empty or absent when it does not.",
    },
    needs_human: IMPLEMENT_NEEDS_HUMAN_SCHEMA,
    spec_conflict: {
      type: "string",
      maxLength: SPEC_CONFLICT_MAX_CHARS,
      description:
        "Only when a done criterion cannot be met inside the spec (it needs a file outside the allowed paths, or it conflicts with a repo rule): " +
        "the criterion and why, in plain text. Nothing is pushed and the spec is revised. Empty or absent otherwise.",
    },
    already_done: { type: "string", maxLength: ALREADY_DONE_MAX_CHARS, description: "Only when the work is already on the base and you made no commits: the done-when checks you saw pass. Empty or absent otherwise." },
  },
};

export const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "tier", "findings", "summary"],
  properties: {
    verdict: { enum: ["pass", "bug"] },
    tier: tierSchema,
    findings: { type: "array", items: closed({ kind: { enum: ["code", "spec"], description: "code: fixable inside the spec. spec: needs the spec changed." }, text: { type: "string" } }) },
    unverified: { ...strings, description: "Checks you could not run or confirm. Never makes the verdict bug." },
    ui_unverified: { type: "boolean", description: "True only when a change to UI paths could not have its build, type-check or screenshots run." },
    built_differently: { type: "array", description: "Done-when lines the diff builds differently. Empty or absent when every line is built as written.", items: closed({
      line: { type: "string", description: "The done-when line." },
      reason: { type: "string", description: "The reason, taken only from the work item (its decisions or owner notes). Empty when it gives none: that is a code finding and the verdict bug." },
    }) },
    summary: { type: "string" },
    needs_human: NEEDS_HUMAN_SCHEMA,
  },
};

export type ReviewConfirmOutput = { confirmed: boolean; reason: string }; // a confirm run's answer (design 04-agents): does the finding hold in the diff, and why
export const REVIEW_CONFIRM_SCHEMA = closed({ confirmed: { type: "boolean" }, reason: { type: "string" } });

type Validation<T> = { ok: true; value: T } | { ok: false; error: string };

/** A plain object (not null, not an array): the shape check every agent answer parser starts from. */
export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isStrs = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);
const isTier = (v: unknown): v is Tier => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 5;
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

/** Repo-relative, no traversal, no absolute paths. */
const isSafePath = (p: string): boolean => p.length > 0 && !p.startsWith("/") && !p.split("/").includes("..");

/**
 * Triage refuses `.claude/` paths (design 04-triage.md, 2026-11-15): they are owner-only and the agent sandbox
 * refuses every write there. The error for a field naming one, null when it names none.
 */
function ownerOnlyError(field: string, paths: readonly string[]): string | null {
  const named = paths.filter((p) => p.split("/").filter((s) => s !== "" && s !== ".")[0] === ".claude");
  return named.length === 0 ? null : `${field}: ${named.join(", ")}: .claude/ paths are owner-only; an agent run cannot write them, so a spec never names one`;
}

/**
 * Tool-call markup (issue #454): an opening or closing parameter, invoke or function_calls tag, or any tag in the
 * runner's antml namespace. Text in backticks or a fenced code block is not checked, so a spec can quote markup.
 */
const TOOL_MARKUP = /<\/?(?:antml:[\w-]+|parameter|invoke|function_calls)\b/i;
/** A code span or fenced block: a run of backticks up to the next run of the same length. */
const CODE = /(`+)[\s\S]*?\1/g;

/** The first field whose text holds tool-call markup outside code, as an error naming it; null when none does. */
function markupError(fields: Record<string, string | readonly string[] | undefined>): string | null {
  for (const [name, value] of Object.entries(fields)) {
    const texts = value === undefined ? [] : typeof value === "string" ? [value] : value;
    if (texts.some((t) => TOOL_MARKUP.test(t.replace(CODE, "")))) return `${name}: tool-call markup outside code`;
  }
  return null;
}

/** A decision's default: a non-empty string, else none. */
const defaultOf = (v: unknown): string | null => (isStr(v) && v.trim() !== "" ? v : null);

/** A decision in triage's shape (issue #526): a question, a reason, a default, and no options or 2 to 4 of them with the default among them. The error names the field. */
function parseQuestion(d: Record<string, unknown>, at: string): SpecDecision | string {
  if (!isStr(d.question) || d.question.trim() === "") return `${at}.question: must be a non-empty string`;
  if (!isStr(d.reason) || d.reason.trim() === "") return `${at}.reason: must be a non-empty string`;
  if (d.default !== undefined && d.default !== null && !isStr(d.default)) return `${at}.default: must be a string`;
  const options = proposedDependency(d.question) !== null ? DEPENDENCY_OPTIONS : d.options ?? []; // a dependency proposal is always yes/no (design 04-triage)
  if (!isStrs(options) || options.some((o) => o.trim() === "") || (options.length > 0 && (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS))) return `${at}.options: must be [] or ${MIN_OPTIONS} to ${MAX_OPTIONS} non-empty strings`;
  const def = defaultOf(d.default);
  if (options.length > 0 && (def === null || !options.includes(def))) return `${at}.default: must be one of the options`;
  for (const k of ["owner_only", "layout"] as const) if (d[k] !== undefined && typeof d[k] !== "boolean") return `${at}.${k}: must be true or false`;
  if (d.layout === true && (options.length < MIN_OPTIONS || options.length > MAX_LAYOUT_OPTIONS)) return `${at}.options: a layout decision needs ${MIN_OPTIONS} to ${MAX_LAYOUT_OPTIONS} options`;
  const changes = parseOptionChanges(d.option_changes, options, at);
  if (isStr(changes)) return changes;
  return { text: d.question, default: def, owner_only: d.owner_only !== false || def === null, reason: d.reason, ...(options.length > 0 ? { options } : {}), ...extras(d, changes) };
}

/** The optional layout flag and option changes of a parsed decision. */
const extras = (d: Record<string, unknown>, changes: OptionChange[]) => ({ ...(d.layout === true ? { layout: true } : {}), ...(changes.length > 0 ? { option_changes: changes } : {}) });

/** `option_changes` (design 04-triage): absent is none; each entry names an option once, with safe `extra_paths` (no `.claude/`) and `done_when` lines. */
function parseOptionChanges(v: unknown, options: readonly string[], at: string): OptionChange[] | string {
  if (v === undefined || v === null) return [];
  const field = `${at}.option_changes`;
  if (!Array.isArray(v)) return `${field}: must be a list`;
  const out: OptionChange[] = [];
  for (const [i, c] of v.entries()) {
    const here = `${field}[${i}]`;
    if (!isObj(c) || !isStr(c.option) || !options.includes(c.option)) return `${here}.option: must be one of the options`;
    if (out.some((o) => o.option === c.option)) return `${here}.option: names an option twice`;
    const extra_paths = c.extra_paths ?? [];
    if (!isStrs(extra_paths) || !extra_paths.every(isSafePath)) return `${here}.extra_paths: must be repo-relative paths`;
    const ownerOnly = ownerOnlyError(`${here}.extra_paths`, extra_paths), done_when = c.done_when ?? [];
    if (ownerOnly) return ownerOnly;
    if (!isStrs(done_when)) return `${here}.done_when: must be a list of strings`;
    const lines = done_when.filter((l) => l.trim() !== ""); // an entry that changes nothing is dropped
    if (extra_paths.length > 0 || lines.length > 0) out.push({ option: c.option, extra_paths, done_when: lines });
  }
  return out;
}

/**
 * The decisions of a triage answer, or an error naming the field. A decision with a `question` is triage's shape
 * (`parseQuestion`). Older shapes still parse: a plain string is an owner-only decision with no default; a stored
 * `{ text, default, owner_only }` keeps a reason and options it holds, and with no flag or no default is owner-only.
 */
function parseDecisions(v: unknown): Validation<SpecDecision[]> {
  if (!Array.isArray(v)) return { ok: false, error: "decisions: must be a list" };
  const out: SpecDecision[] = [];
  for (const [i, d] of v.entries()) {
    const at = `decisions[${i}]`;
    if (isStr(d)) out.push({ text: d, default: null, owner_only: true });
    else if (isObj(d) && d.question !== undefined) {
      const q = parseQuestion(d, at);
      if (isStr(q)) return { ok: false, error: q };
      out.push(q);
    } else if (isObj(d) && isStr(d.text) && (d.default === undefined || d.default === null || isStr(d.default))) {
      const def = defaultOf(d.default);
      const options = isStrs(d.options) ? d.options : [];
      const changes = parseOptionChanges(d.option_changes, options, at);
      if (isStr(changes)) return { ok: false, error: changes };
      out.push({ text: d.text, default: def, owner_only: d.owner_only !== false || def === null, ...(isStr(d.reason) ? { reason: d.reason } : {}),
        ...(options.length > 0 ? { options } : {}), ...extras(d, changes) });
    } else return { ok: false, error: `${at}.question: must be a non-empty string` };
  }
  return { ok: true, value: out };
}

/** A decision as the spec comment lists it: the question, its proposed default, and whether only the owner answers. */
function decisionLine(d: SpecDecision): string {
  // No default (an older plain-text decision included): the line as triage wrote it.
  if (d.default === null) return d.text;
  return `${d.text} Proposed default: ${d.default}.${d.owner_only ? " (owner only)" : ""}`;
}

/** A phase list: absent or empty is no split; otherwise 2 to 4 phases, each with every field filled in. */
function parsePhases(v: unknown): Validation<TriagePhase[] | undefined> {
  if (v === undefined || (Array.isArray(v) && v.length === 0)) return { ok: true, value: undefined };
  if (!Array.isArray(v)) return { ok: false, error: "phases" };
  if (v.length < MIN_PHASES || v.length > MAX_PHASES) return { ok: false, error: `phases: a split has ${MIN_PHASES} to ${MAX_PHASES} phases, not ${v.length}` };
  const phases: TriagePhase[] = [];
  for (const [i, p] of v.entries()) {
    const bad = (what: string): Validation<never> => ({ ok: false, error: `phases[${i}].${what}` });
    if (!isObj(p)) return { ok: false, error: `phases[${i}]` };
    if (!isStr(p.title) || p.title.trim() === "") return bad("title");
    if (!isStr(p.problem) || p.problem.trim() === "") return bad("problem");
    if (!isStrs(p.done_criteria) || p.done_criteria.length === 0) return bad("done_criteria");
    if (!isStrs(p.allowed_paths) || p.allowed_paths.length === 0 || !p.allowed_paths.every(isSafePath)) return bad("allowed_paths");
    const ownerOnly = ownerOnlyError(`phases[${i}].allowed_paths`, p.allowed_paths);
    if (ownerOnly) return { ok: false, error: ownerOnly };
    const markup = markupError({ title: p.title, problem: p.problem, done_criteria: p.done_criteria });
    if (markup) return { ok: false, error: `phases[${i}].${markup}` };
    phases.push({ title: p.title, problem: p.problem, done_criteria: p.done_criteria, allowed_paths: p.allowed_paths });
  }
  return { ok: true, value: phases };
}

/** Validates a triage answer; with both caps in `limits` an estimate over the split threshold also needs 2 to 4 phases, and `check_commands` (the triage branch's) requires done_checks. */
export function parseTriage(v: unknown, limits?: Partial<SplitLimits> & { check_commands?: readonly string[] }): Validation<TriageOutput> {
  if (!isObj(v)) return { ok: false, error: "not an object" };
  const {
    in_short, problem, done_criteria, desired_output, scope, allowed_paths, files_to_change, tier, tier_reason, estimated_lines,
    estimated_files,
  } = v;
  if (!isStr(in_short) || !isStr(problem) || !isStr(desired_output) || !isStr(tier_reason)) {
    const name = (["in_short", "problem", "desired_output", "tier_reason"] as const).find((k) => !isStr(v[k]));
    return { ok: false, error: `${name}: must be a string` };
  }
  // Separate lists (issue #229) when both are given; an older output's `scope` text otherwise.
  const lists = v.in_scope !== undefined || v.out_of_scope !== undefined;
  if (lists && (!isStrs(v.in_scope) || !isStrs(v.out_of_scope))) return { ok: false, error: "in_scope/out_of_scope" };
  if (!lists && !isStr(scope)) return { ok: false, error: "scope: must be a string, or in_scope and out_of_scope lists" };
  const scoped = lists
    ? { scope: scopeText(v.in_scope as string[], v.out_of_scope as string[]), in_scope: v.in_scope as string[], out_of_scope: v.out_of_scope as string[] }
    : { scope: scope as string };
  // Optional: a triage output without `decisions` means none (the schema does not require it). A stored, already
  // parsed answer (the worker keeps parseTriage's value) carries them as `decision_items`, its `decisions` the lines.
  const parsedDecisions = parseDecisions(v.decision_items ?? v.decisions ?? []);
  if (!parsedDecisions.ok) return parsedDecisions;
  const decision_items = parsedDecisions.value;
  const decisions = decision_items.map(decisionLine);
  const applied_defaults = v.applied_defaults ?? [];
  if (!isStrs(applied_defaults)) return { ok: false, error: "applied_defaults: must be a list of strings" };
  if (!isStrs(done_criteria) || done_criteria.length === 0) return { ok: false, error: "done_criteria" };
  const checks = parseDoneChecks(v.done_checks, done_criteria, limits?.check_commands);
  if (!checks.ok) return checks;
  // Bare tool-call markup (issue #446) is refused, never repaired: the run is retried like any invalid output.
  const markup = markupError({
    in_short, problem, desired_output, tier_reason, ...(lists ? { in_scope: scoped.in_scope, out_of_scope: scoped.out_of_scope } : { scope: scoped.scope }),
    done_criteria, applied_defaults, goal_done_when: isStrs(v.goal_done_when) ? v.goal_done_when : undefined, done_checks: (checks.value ?? []).flatMap((c) => ("reason" in c ? [c.reason] : [])),
    decisions: [...decisions, ...decision_items.flatMap((d) => [d.reason ?? "", ...(d.options ?? []), ...(d.option_changes ?? []).flatMap((c) => c.done_when)])],
  });
  if (markup) return { ok: false, error: markup };
  if (!isStrs(allowed_paths) || allowed_paths.length === 0 || !allowed_paths.every(isSafePath)) return { ok: false, error: "allowed_paths" };
  const pinned = v.pinned_tests ?? []; // the base tests that pin the answer (design 04-triage, 2026-11-25)
  if (!isStrs(files_to_change) || !files_to_change.every(isSafePath) || !isStrs(pinned) || !pinned.every((p) => files_to_change.includes(p))) return { ok: false, error: isStrs(files_to_change) && files_to_change.every(isSafePath) ? "pinned_tests: each must be in files_to_change" : "files_to_change" };
  const ownerOnly = ownerOnlyError("allowed_paths", allowed_paths) ?? ownerOnlyError("files_to_change", files_to_change);
  if (ownerOnly) return { ok: false, error: ownerOnly };
  const uncovered = files_to_change.filter((p) => !isCovered(p, allowed_paths));
  if (uncovered.length > 0) {
    return { ok: false, error: `files_to_change not covered by allowed_paths: ${uncovered.join(", ")}` };
  }
  if (!isTier(tier)) return { ok: false, error: "tier" };
  if (!isCount(estimated_lines) || !isCount(estimated_files)) return { ok: false, error: "estimated_lines/estimated_files" };
  const phases = parsePhases(v.phases);
  if (!phases.ok) return phases;
  const goal = parseGoalLines(v.goal_done_when, phases.value?.length ?? 0);
  if (!goal.ok) return goal;
  if (limits?.max_diff_lines !== undefined && limits.max_diff_files !== undefined) {
    const err = splitError({ estimated_lines, estimated_files }, phases.value?.length ?? 0, { max_diff_lines: limits.max_diff_lines, max_diff_files: limits.max_diff_files });
    if (err) return { ok: false, error: err };
  }
  return {
    ok: true,
    value: {
      in_short, problem, done_criteria, desired_output, ...scoped, allowed_paths, files_to_change, tier, tier_reason, estimated_lines,
      estimated_files, decisions, decision_items, applied_defaults, ...(phases.value ? { phases: phases.value } : {}), ...(goal.value ? { goal_done_when: goal.value } : {}),
      ...(checks.value ? { done_checks: checks.value } : {}), ...(pinned.length > 0 ? { pinned_tests: pinned } : {}),
    },
  };
}

/** A short, non-empty plain-text field of needs_human. */
const isShort = (v: unknown): v is string => isStr(v) && v.trim() !== "" && v.length <= NEEDS_HUMAN_MAX_CHARS;

/** The optional needs_human: absent (or null) is none; else reason and question are non-empty, at most NEEDS_HUMAN_MAX_CHARS. Else invalid output. */
export function parseNeedsHuman(v: unknown): Validation<NeedsHuman | undefined> {
  if (v === undefined || v === null) return { ok: true, value: undefined };
  if (!isObj(v) || !isShort(v.reason) || !isShort(v.question)) {
    return { ok: false, error: `needs_human: reason and question must be non-empty and at most ${NEEDS_HUMAN_MAX_CHARS} characters` };
  }
  const paths = v.paths ?? [];
  if (!isStrs(paths) || paths.length > NEEDS_HUMAN_MAX_PATHS || paths.some((p) => p.length > NEEDS_HUMAN_MAX_CHARS)) {
    return { ok: false, error: `needs_human: paths must be at most ${NEEDS_HUMAN_MAX_PATHS} strings` };
  }
  const kept = paths.map((p) => p.trim()).filter(Boolean);
  return { ok: true, value: { reason: v.reason.trim(), question: v.question.trim(), ...(kept.length ? { paths: kept } : {}) } };
}

/** Why an answer is not an object: no answer (it stopped at max turns), plain text (it answered in prose), or another type. */
function noAnswerError(v: unknown): string {
  if (v === undefined || v === null || v === "") return "no structured answer: the agent ended without one";
  // The text itself stays in the run's output tail: a failure detail never carries unscanned agent text.
  if (typeof v === "string") return "no structured answer: the agent ended with plain text instead";
  return `no structured answer: the answer is ${Array.isArray(v) ? "an array" : `a ${typeof v}`}, not an object`;
}

/** An implement or resolve answer. With needs_human or spec_conflict, summary and next_steps may be left out (they become ""). `missing` and `deviations` are optional lists; absent is []. */
export function parseImplement(v: unknown): Validation<ImplementOutput> {
  if (!isObj(v)) return { ok: false, error: noAnswerError(v) };
  const ask = parseNeedsHuman(v.needs_human);
  if (!ask.ok) return ask;
  const notes = (x: unknown) => x === undefined || (isStrs(x) && x.length <= PR_NOTE_MAX_ITEMS && x.every((e) => e.length <= PR_NOTE_MAX_CHARS));
  if (!notes(v.missing) || !notes(v.deviations)) return { ok: false, error: "missing/deviations" };
  const conflict = v.spec_conflict ?? "", done = v.already_done ?? "";
  if (!isStr(conflict) || conflict.length > SPEC_CONFLICT_MAX_CHARS) return { ok: false, error: "spec_conflict" };
  if (!isStr(done) || done.length > ALREADY_DONE_MAX_CHARS) return { ok: false, error: "already_done" };
  const lists = {
    missing: ((v.missing as string[] | undefined) ?? []).map((e) => e.trim()).filter(Boolean),
    deviations: ((v.deviations as string[] | undefined) ?? []).map((e) => e.trim()).filter(Boolean),
    ...(conflict.trim() ? { spec_conflict: conflict.trim() } : {}),
    ...(done.trim() ? { already_done: done.trim() } : {}),
  };
  // An agent that stops (needs_human) or reports a spec it cannot meet (spec_conflict) has no change to summarize.
  if (ask.value || lists.spec_conflict) {
    const optional = (x: unknown) => x === undefined || isStr(x);
    if (!optional(v.summary) || !optional(v.next_steps)) return { ok: false, error: "summary/next_steps" };
    const value = { summary: (v.summary as string | undefined) ?? "", next_steps: (v.next_steps as string | undefined) ?? "", ...lists };
    return { ok: true, value: { ...value, ...(ask.value ? { needs_human: ask.value } : {}) } };
  }
  if (!isStr(v.summary) || !isStr(v.next_steps)) return { ok: false, error: "summary/next_steps" };
  return { ok: true, value: { summary: v.summary, next_steps: v.next_steps, ...lists } };
}

const findingOf = (f: unknown): ReviewFinding | null => (isObj(f) && (f.kind === "code" || f.kind === "spec") && isStr(f.text) ? { kind: f.kind, text: f.text } : null);
export function parseReview(v: unknown): Validation<ReviewOutput> {
  if (!isObj(v)) return { ok: false, error: "not an object" };
  const { verdict, tier, findings, summary } = v;
  if (verdict !== "pass" && verdict !== "bug") return { ok: false, error: "verdict" };
  if (!isTier(tier) || !Array.isArray(findings) || !isStr(summary)) return { ok: false, error: "tier/findings/summary" };
  const parsed: ReviewFinding[] = [];
  for (const [i, f] of findings.entries()) {
    // An older review's finding is a plain string: a code finding (issue #222).
    const p = isStr(f) ? { kind: "code" as const, text: f } : findingOf(f);
    if (!p) return { ok: false, error: `findings[${i}]: an object with kind "code" or "spec" and a text` };
    parsed.push(p);
  }
  const unconfirmed = Array.isArray(v.unconfirmed) ? v.unconfirmed.map(findingOf) : v.unconfirmed === undefined ? [] : [null]; // set by the worker's confirm runs
  if (unconfirmed.includes(null)) return { ok: false, error: "unconfirmed" };
  const unverified = v.unverified ?? [];
  if (!isStrs(unverified)) return { ok: false, error: "unverified" };
  if (v.ui_unverified !== undefined && typeof v.ui_unverified !== "boolean") return { ok: false, error: "ui_unverified" };
  const differently = v.built_differently ?? [];
  if (!Array.isArray(differently) || !differently.every((d) => isObj(d) && isStr(d.line) && isStr(d.reason))) return { ok: false, error: "built_differently" };
  const lines = (differently as BuiltDifferently[]).map((d) => ({ line: d.line.trim(), reason: d.reason.trim() })).filter((d) => d.line);
  // A line built differently with no reason in the work item is a defect (design 04-agents): a code finding.
  for (const d of lines) if (!d.reason) parsed.push({ kind: "code", text: `${BUILT_DIFFERENTLY_FINDING}${d.line}` });
  const built = lines.filter((d) => d.reason);
  const ask = parseNeedsHuman(v.needs_human);
  if (!ask.ok) return ask;
  return { ok: true, value: {
    verdict: parsed.length > findings.length ? "bug" : verdict, tier, findings: parsed, summary, ...(unverified.length > 0 ? { unverified } : {}),
    ...(v.ui_unverified === true ? { ui_unverified: true } : {}), ...(built.length > 0 ? { built_differently: built } : {}),
    ...(unconfirmed.length > 0 ? { unconfirmed: unconfirmed as ReviewFinding[] } : {}), ...(ask.value ? { needs_human: ask.value } : {}),
  } };
}

/** A confirm run's answer: `confirmed` a boolean and `reason` a string, else no valid answer (its finding stays). */
export function parseReviewConfirm(v: unknown): Validation<ReviewConfirmOutput> {
  if (!isObj(v) || typeof v.confirmed !== "boolean" || !isStr(v.reason)) return { ok: false, error: isObj(v) ? "confirmed/reason" : noAnswerError(v) };
  return { ok: true, value: { confirmed: v.confirmed, reason: v.reason.trim() } };
}

export const JUDGE_VERDICTS = ["next", "fix", "done", "ask"] as const;
export type JudgeOutput = { verdict: (typeof JUDGE_VERDICTS)[number]; reason: string; fix?: TriagePhase }; // a judge run's answer (design 04-split-specs): `fix` names the phase to add
/** A judge answer: a verdict of JUDGE_VERDICTS and a reason; `fix` needs a title, a problem, a done criterion and an allowed path. */
export function parseJudge(v: unknown): Validation<JudgeOutput> {
  const verdict = isObj(v) ? JUDGE_VERDICTS.find((x) => x === v.verdict) : undefined, reason = isObj(v) && isStr(v.reason) ? v.reason.trim() : "", f = isObj(v) ? v.fix : null;
  if (!verdict || !reason) return { ok: false, error: isObj(v) ? `verdict (${JUDGE_VERDICTS.join(", ")}) and reason` : noAnswerError(v) };
  const lines = (x: unknown) => (isStrs(x) ? x.map((l) => l.trim()).filter(Boolean) : []), fix = isObj(f) && isStr(f.title) && isStr(f.problem) ? { title: f.title.trim(), problem: f.problem.trim(), done_criteria: lines(f.done_criteria), allowed_paths: lines(f.allowed_paths) } : null;
  if (verdict !== "fix") return { ok: true, value: { verdict, reason } };
  return fix?.title && fix.problem && fix.done_criteria.length > 0 && fix.allowed_paths.length > 0 ? { ok: true, value: { verdict, reason, fix } } : { ok: false, error: "fix: a title, a problem, a done criterion and an allowed path" };
}
