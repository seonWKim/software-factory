// A skill-eval case's checks (design 06-measurement, check and pass rules): what `expected` holds, how each check is
// valued and when a case passes. `expected` is a list of checks, or `{"checks": [...], "threshold": n}`. A string is a
// must-have yes/no check the judge answers. An object names its `kind`: a deterministic check run here with no model
// call (contains, does-not-contain, regex, max length, valid JSON, JSON schema subset), a `rubric` criterion the judge
// scores 1 to 5 by its anchors, or a `pairwise` check the judge answers against the previous version's stored answer.
// Each takes an optional `weight` (≥ 0, default 1) and `must` (default true for strings and deterministic checks,
// false for rubric and pairwise). The engine (engine.ts) runs the checks and applies caseVerdict; authoring refuses a
// case parseCaseChecks refuses. Pure: no I/O, no clock.

export const DETERMINISTIC_KINDS = ["contains", "does-not-contain", "regex", "max length", "valid JSON", "JSON schema subset"] as const;
export type DeterministicKind = (typeof DETERMINISTIC_KINDS)[number];
/** A rubric's levels: one anchor sentence each. */
export const RUBRIC_LEVELS = ["1", "2", "3", "4", "5"] as const;
export type RubricLevel = (typeof RUBRIC_LEVELS)[number];

/** The pass score when a case gives no threshold and has a rubric or pairwise check (decision 1). */
export const JUDGED_THRESHOLD = 0.8;

interface Weighted {
  weight: number;
  must: boolean;
}
export type YesNoCheck = Weighted & { kind: "yes/no"; check: string };
export type DeterministicCheck = Weighted & (
  | { kind: "contains" | "does-not-contain"; value: string }
  | { kind: "regex"; pattern: string; flags: string }
  | { kind: "max length"; max: number }
  | { kind: "valid JSON" }
  | { kind: "JSON schema subset"; schema: Record<string, unknown> }
);
export type RubricCheck = Weighted & { kind: "rubric"; criterion: string; anchors: Record<RubricLevel, string> };
export type PairwiseCheck = Weighted & { kind: "pairwise"; criterion: string };
export type Check = YesNoCheck | DeterministicCheck | RubricCheck | PairwiseCheck;

/** A case's checks in their given order, and the score it must reach. */
export interface CaseChecks {
  checks: Check[];
  threshold: number;
}

/** One rubric criterion as the judge reads it. */
export interface RubricCriterion {
  criterion: string;
  anchors: Record<RubricLevel, string>;
}
/** A rubric score with its reason, the reason written first. */
export interface RubricAnswer {
  reason: string;
  score: number;
}
/** One yes/no answer with its reason. */
export interface YesNoAnswer {
  answer: "yes" | "no";
  reason: string;
}
/** One score per criterion, in order; null when the judge could not answer. */
export type RubricJudgeFn = (s: { input: string; output: string; criteria: readonly RubricCriterion[] }, signal: AbortSignal) => Promise<readonly RubricAnswer[] | null>;
/**
 * Whether answer `candidate` beats the other one for `criterion`; the two answers are shown as A then B, unlabelled by
 * version. Null when the judge could not answer.
 */
export type PairwiseJudgeFn = (s: { input: string; criterion: string; a: string; b: string; candidate: "A" | "B" }, signal: AbortSignal) => Promise<YesNoAnswer | null>;

/** One check's outcome as a replay's detail stores it. */
export interface CheckResult {
  check: string;
  /** `yes` when the check passed (a pairwise check left out passes). */
  answer: "yes" | "no";
  reason: string;
  kind: Check["kind"];
  weight: number;
  must: boolean;
  /** 0 to 1; null when the check is left out of the score (a pairwise check with no previous answer). */
  value: number | null;
  /** A rubric's 1 to 5 score. */
  score?: number;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/** The keys each kind takes beside `kind`, `weight` and `must`. */
const KEYS: Record<Exclude<Check["kind"], "yes/no">, readonly string[]> = {
  contains: ["value"], "does-not-contain": ["value"], regex: ["pattern", "flags"], "max length": ["max"], "valid JSON": [],
  "JSON schema subset": ["schema"], rubric: ["criterion", "anchors"], pairwise: ["criterion"],
};

/** The JSON schema keywords the subset check reads; a schema using any other is refused. */
const SCHEMA_KEYS = ["type", "enum", "const", "required", "properties", "additionalProperties", "items", "minItems", "maxItems", "minLength", "maxLength", "minimum", "maximum"] as const;
const SCHEMA_TYPES = ["object", "array", "string", "number", "integer", "boolean", "null"];

/** What is wrong with `schema` as a JSON schema subset, else null. */
function schemaProblem(schema: unknown): string | null {
  if (!isObject(schema)) return "a schema must be an object";
  const other = Object.keys(schema).find((k) => !(SCHEMA_KEYS as readonly string[]).includes(k));
  if (other) return `schema keyword ${other} is not in the subset (${SCHEMA_KEYS.join(", ")})`;
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.some((t) => !SCHEMA_TYPES.includes(t as string))) return `schema type must be one of ${SCHEMA_TYPES.join(", ")}`;
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) return "schema enum must be a list";
  if (schema.required !== undefined && !(Array.isArray(schema.required) && schema.required.every((r) => typeof r === "string"))) return "schema required must be a list of names";
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") return "schema additionalProperties must be true or false";
  for (const k of ["minItems", "maxItems", "minLength", "maxLength", "minimum", "maximum"] as const) {
    if (schema[k] !== undefined && (typeof schema[k] !== "number" || !Number.isFinite(schema[k]))) return `schema ${k} must be a number`;
  }
  if (schema.properties !== undefined) {
    if (!isObject(schema.properties)) return "schema properties must be an object";
    for (const s of Object.values(schema.properties)) {
      const bad = schemaProblem(s);
      if (bad) return bad;
    }
  }
  return schema.items === undefined ? null : schemaProblem(schema.items);
}

/** One check object parsed, or what is wrong with it. */
function parseObject(o: Record<string, unknown>): Check | string {
  const kind = o.kind;
  if (typeof kind !== "string" || !Object.hasOwn(KEYS, kind)) return `unknown check kind ${JSON.stringify(kind)}: use a check text, ${DETERMINISTIC_KINDS.join(", ")}, rubric or pairwise`;
  const k = kind as keyof typeof KEYS;
  const extra = Object.keys(o).find((key) => key !== "kind" && key !== "weight" && key !== "must" && !KEYS[k].includes(key));
  if (extra) return `a ${k} check takes no ${extra}`;
  const weight = o.weight ?? 1;
  if (typeof weight !== "number" || !Number.isFinite(weight) || weight < 0) return `a ${k} check's weight must be a number of 0 or more`;
  const must = o.must ?? (k !== "rubric" && k !== "pairwise");
  if (typeof must !== "boolean") return `a ${k} check's must must be true or false`;
  const w = { weight, must };
  switch (k) {
    case "contains":
    case "does-not-contain":
      return typeof o.value === "string" && o.value !== "" ? { kind: k, value: o.value, ...w } : `a ${k} check needs a value text`;
    case "regex": {
      const flags = o.flags ?? "";
      if (typeof o.pattern !== "string" || o.pattern === "" || typeof flags !== "string") return "a regex check needs a pattern text (and flags as text)";
      try {
        new RegExp(o.pattern, flags);
      } catch {
        return `regex ${o.pattern} with flags "${flags}" is not a valid regular expression`;
      }
      return { kind: k, pattern: o.pattern, flags, ...w };
    }
    case "max length":
      return Number.isInteger(o.max) && (o.max as number) >= 0 ? { kind: k, max: o.max as number, ...w } : "a max length check needs max, a whole number of characters";
    case "valid JSON":
      return { kind: k, ...w };
    case "JSON schema subset": {
      const bad = schemaProblem(o.schema);
      return bad ?? { kind: k, schema: o.schema as Record<string, unknown>, ...w };
    }
    case "rubric": {
      if (!text(o.criterion)) return "a rubric check needs a criterion text";
      const anchors = o.anchors;
      if (!isObject(anchors)) return `a rubric check needs anchors, one sentence for each level ${RUBRIC_LEVELS.join(" to ")}`;
      const missing = RUBRIC_LEVELS.find((l) => !text(anchors[l]));
      if (missing) return `rubric "${o.criterion}" has no anchor for level ${missing}`;
      const other = Object.keys(anchors).find((l) => !(RUBRIC_LEVELS as readonly string[]).includes(l));
      if (other) return `rubric "${o.criterion}" has an anchor for ${other}: levels are ${RUBRIC_LEVELS.join(" to ")}`;
      return { kind: k, criterion: o.criterion, anchors: anchors as Record<RubricLevel, string>, ...w };
    }
    case "pairwise":
      return text(o.criterion) ? { kind: k, criterion: o.criterion, ...w } : "a pairwise check needs a criterion text";
  }
}

/** The default threshold: 1 when every check is yes/no or deterministic, else JUDGED_THRESHOLD. */
const defaultThreshold = (checks: readonly Check[]): number => (checks.some((c) => c.kind === "rubric" || c.kind === "pairwise") ? JUDGED_THRESHOLD : 1);

/** A case's `expected` parsed into its checks and threshold, or what is wrong with it. */
export function parseCaseChecks(expected: unknown): { value: CaseChecks } | { refused: string } {
  const list = Array.isArray(expected) ? expected : isObject(expected) ? expected.checks : undefined;
  if (!Array.isArray(list) || list.length === 0) return { refused: 'expected must be a list of rubric check texts or check objects, or {"checks": [...]}' };
  const checks: Check[] = [];
  for (const item of list) {
    const c = text(item) ? { kind: "yes/no" as const, check: item, weight: 1, must: true } : isObject(item) ? parseObject(item) : "a check is a text or an object with a kind";
    if (typeof c === "string") return { refused: c };
    checks.push(c);
  }
  const threshold = isObject(expected) && expected.threshold !== undefined ? expected.threshold : defaultThreshold(checks);
  if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) return { refused: "threshold must be a number from 0 to 1" };
  return { value: { checks, threshold } };
}

/** A check's line in the replay's detail and in `case try`. */
export function checkLabel(c: Check): string {
  switch (c.kind) {
    case "yes/no": return c.check;
    case "contains":
    case "does-not-contain": return `${c.kind} ${JSON.stringify(c.value)}`;
    case "regex": return `regex /${c.pattern}/${c.flags}`;
    case "max length": return `max length ${c.max}`;
    case "valid JSON":
    case "JSON schema subset": return c.kind;
    case "rubric": return c.criterion;
    case "pairwise": return `pairwise: ${c.criterion}`;
  }
}

export const isDeterministic = (c: Check): c is DeterministicCheck => (DETERMINISTIC_KINDS as readonly string[]).includes(c.kind);

/** The type of a JSON value as the schema names it. */
function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/** Where `v` misses `schema` (a schemaProblem-free subset), else null. */
function schemaMiss(schema: Record<string, unknown>, v: unknown, at: string): string | null {
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
  const t = typeOf(v);
  if (types.length > 0 && !types.some((x) => x === t || (x === "integer" && Number.isInteger(v)))) return `${at} is ${t}, not ${types.join(" or ")}`;
  const same = (x: unknown) => JSON.stringify(x) === JSON.stringify(v);
  if (schema.const !== undefined && !same(schema.const)) return `${at} is not ${JSON.stringify(schema.const)}`;
  if (Array.isArray(schema.enum) && !schema.enum.some(same)) return `${at} is none of ${JSON.stringify(schema.enum)}`;
  const n = (k: string) => schema[k] as number | undefined;
  if (typeof v === "string" && ((n("minLength") ?? 0) > v.length || v.length > (n("maxLength") ?? Infinity))) return `${at} has ${v.length} characters, out of bounds`;
  if (typeof v === "number" && ((n("minimum") ?? -Infinity) > v || v > (n("maximum") ?? Infinity))) return `${at} is ${v}, out of bounds`;
  if (Array.isArray(v)) {
    if ((n("minItems") ?? 0) > v.length || v.length > (n("maxItems") ?? Infinity)) return `${at} has ${v.length} items, out of bounds`;
    if (isObject(schema.items)) for (const [i, x] of v.entries()) {
      const miss = schemaMiss(schema.items, x, `${at}[${i}]`);
      if (miss) return miss;
    }
  }
  if (isObject(v)) {
    const props = isObject(schema.properties) ? schema.properties : {};
    const absent = ((schema.required as string[] | undefined) ?? []).find((r) => !Object.hasOwn(v, r));
    if (absent) return `${at} has no ${absent}`;
    if (schema.additionalProperties === false) {
      const extra = Object.keys(v).find((k) => !Object.hasOwn(props, k));
      if (extra) return `${at} has ${extra}, not in its properties`;
    }
    for (const [k, s] of Object.entries(props)) {
      if (!Object.hasOwn(v, k) || !isObject(s)) continue;
      const miss = schemaMiss(s, v[k], `${at}.${k}`);
      if (miss) return miss;
    }
  }
  return null;
}

const parsed = (output: string): { json: unknown } | null => {
  try {
    return { json: JSON.parse(output) };
  } catch {
    return null;
  }
};

/** Runs one deterministic check on the replay's output; no model call. */
export function runDeterministic(c: DeterministicCheck, output: string): { pass: boolean; reason: string } {
  switch (c.kind) {
    case "contains": {
      const pass = output.includes(c.value);
      return { pass, reason: pass ? "the output contains it" : "the output does not contain it" };
    }
    case "does-not-contain": {
      const pass = !output.includes(c.value);
      return { pass, reason: pass ? "the output does not contain it" : "the output contains it" };
    }
    case "regex": {
      const pass = new RegExp(c.pattern, c.flags).test(output);
      return { pass, reason: pass ? "the output matches" : "the output does not match" };
    }
    case "max length": {
      const pass = output.length <= c.max;
      return { pass, reason: `the output has ${output.length} characters` };
    }
    case "valid JSON":
      return parsed(output) ? { pass: true, reason: "the output is JSON" } : { pass: false, reason: "the output is not JSON" };
    case "JSON schema subset": {
      const p = parsed(output);
      if (!p) return { pass: false, reason: "the output is not JSON" };
      const miss = schemaMiss(c.schema, p.json, "the output");
      return miss ? { pass: false, reason: miss } : { pass: true, reason: "the output fits the schema" };
    }
  }
}

/** A rubric score's value: (score − 1) ÷ 4. */
export const rubricValue = (score: number): number => (score - 1) / 4;

/** Scores within this of the threshold reach it (floating point sums). */
const EPSILON = 1e-9;

/** The case score: sum of weight × value ÷ sum of weights, over checks not left out; 1 when no weight counts. */
export function caseScore(results: readonly Pick<CheckResult, "weight" | "value">[]): number {
  const counted = results.filter((r) => r.value !== null);
  const total = counted.reduce((s, r) => s + r.weight, 0);
  return total === 0 ? 1 : counted.reduce((s, r) => s + r.weight * r.value!, 0) / total;
}

/** Whether a check's value reaches the case threshold: how a rubric passes as a must-have. */
export const reaches = (value: number, threshold: number): boolean => value + EPSILON >= threshold;

/** `pass` when every must-have check passes and the score reaches the threshold, else `fail`. */
export function caseVerdict(results: readonly CheckResult[], threshold: number): "pass" | "fail" {
  return results.every((r) => !r.must || r.answer === "yes") && reaches(caseScore(results), threshold) ? "pass" : "fail";
}
