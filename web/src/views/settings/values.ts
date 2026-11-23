import type { MessageKey } from "../../i18n/en.js";
import { t } from "../../i18n/index.js";

/** A JSON string value as its text; anything else as it is. */
export function stringOf(text: string): string {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "string" ? v : text;
  } catch {
    return text;
  }
}

/** A list value (a JSON array of strings) as its items; anything else is an empty list. */
export function stringItems(text: string): string[] {
  try {
    const v: unknown = JSON.parse(text);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** hold_policy (design 03-risk): the server's modes, the select's choices, and the minutes `run_after_minutes` takes (default 120). */
export const HOLD_CHOICES = ["hold", "start", "wait"] as const;
export type HoldChoice = (typeof HOLD_CHOICES)[number];
export type HoldMode = "hold" | "run" | "run_after_minutes";
export const HOLD_MODES: Record<HoldChoice, HoldMode> = { hold: "hold", start: "run", wait: "run_after_minutes" };
export const HOLD_CHOICE: Record<HoldMode, HoldChoice> = { hold: "hold", run: "start", run_after_minutes: "wait" };
const DEFAULT_HOLD_MINUTES = "120";
export interface HoldDraft {
  mode: HoldMode;
  minutes: string;
}

/** The stored hold_policy JSON as a mode and minutes; anything else reads as hold. */
export function holdOf(text: string): HoldDraft {
  const obj = asObject(text);
  const mode = obj?.mode === "run" || obj?.mode === "run_after_minutes" ? obj.mode : "hold";
  return { mode, minutes: typeof obj?.minutes === "number" ? String(obj.minutes) : DEFAULT_HOLD_MINUTES };
}

/** The JSON object in `text`, or null when it holds anything else. */
export function asObject(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** `text` pretty-printed, two spaces per level; text that is not JSON as it is. */
export function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** An object's entries as `path → value`, nested objects flattened to dotted paths ("implement.1 → standard"). */
export function entries(value: unknown, path = ""): [string, string][] {
  if (typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length > 0) {
    return Object.entries(value).flatMap(([k, v]) => entries(v, path ? `${path}.${k}` : k));
  }
  return [[path, typeof value === "string" ? value : JSON.stringify(value)]];
}

/** Up to this many entries an object is listed in full; above it, a summary that opens to the list. */
export const SHORT_OBJECT = 3;

/** An object's one-line summary: its top-level keys. */
export const summaryOf = (obj: Record<string, unknown>, key: MessageKey = "settings.keysSummary") => t(key, { count: Object.keys(obj).length, keys: Object.keys(obj).join(", ") });

/** "3rd": the attempt number as a word, its suffix from the catalog. */
function ordinal(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const key = teen ? "settings.ordinalTh" : n % 10 === 1 ? "settings.ordinalSt" : n % 10 === 2 ? "settings.ordinalNd" : n % 10 === 3 ? "settings.ordinalRd" : "settings.ordinalTh";
  return t(key, { n });
}

/**
 * model_by as one plain line: the planning class, the building class of the first try and the class building moves to
 * (and from which try); null when the value has no planning class or no building classes to read.
 */
export function modelSummary(text: string): string | null {
  const by = asObject(text);
  const planning = by?.triage;
  const tries = asObject(JSON.stringify(by?.implement ?? null));
  if (typeof planning !== "string" || tries === null) return null;
  const steps = Object.entries(tries)
    .map(([n, cls]) => [Number(n), cls] as const)
    .filter((e): e is readonly [number, string] => Number.isInteger(e[0]) && typeof e[1] === "string")
    .sort((a, b) => a[0] - b[0]);
  const first = steps[0]?.[1];
  if (first === undefined) return null;
  const later = steps.find(([, cls]) => cls !== first);
  return later === undefined
    ? t("settings.modelSummaryFlat", { planning, first })
    : t("settings.modelSummary", { planning, first, later: later[1], nth: ordinal(later[0]) });
}
