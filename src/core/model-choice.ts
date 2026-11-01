// Model class per agent run (design §4, decision 2026-11-02): run kind × tier, plus one class up for a
// retry after a review loop. Pure: the composition root parses `model_by` and `models` from
// factory.config.json once at startup; the worker and golden only look classes up.

import type { RunKind, Tier } from "./types.js";

/** Model classes, cheapest first. A class maps to a model name through `models` in factory.config.json. */
export const MODEL_CLASSES = ["cheap", "standard", "strong"] as const;
export type ModelClass = (typeof MODEL_CLASSES)[number];

/** The run kinds that run an agent. `update` runs no agent and has no class. */
export const MODEL_RUN_KINDS = ["triage", "implement", "review", "resolve"] as const;
export type ModelRunKind = (typeof MODEL_RUN_KINDS)[number];

export const TIER_KEYS = ["1", "2", "3", "4", "5"] as const;

/** Model name per class (`models` in factory.config.json), e.g. { cheap: "haiku", standard: "sonnet", strong: "opus" }. */
export type ModelNames = Record<ModelClass, string>;

/** `model_by`, checked and expanded: a class for every run kind at every tier. */
export interface ModelTable {
  by: Record<ModelRunKind, Record<Tier, ModelClass>>;
  /** Implement and resolve runs of an item with loop_count ≥ 1 go one class up. Default true. */
  retry_up: boolean;
}

/**
 * The shipped `model_by` (factory.config.json holds exactly this). Each run kind is one class for every
 * tier, or a class per tier "1" to "5". Also the table used when `model_by` is absent.
 */
export const DEFAULT_MODEL_BY = {
  triage: "cheap",
  implement: { "1": "standard", "2": "standard", "3": "strong", "4": "strong", "5": "strong" },
  review: "standard",
  resolve: { "1": "standard", "2": "standard", "3": "strong", "4": "strong", "5": "strong" },
  retry_up: true,
} as const;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isClass(v: unknown): v is ModelClass {
  return typeof v === "string" && (MODEL_CLASSES as readonly string[]).includes(v);
}

function classAt(v: unknown, at: string): ModelClass {
  if (!isClass(v)) throw new Error(`model_by: ${at} is ${JSON.stringify(v)}; must be one of ${MODEL_CLASSES.join(", ")}`);
  return v;
}

/**
 * Checks and expands `model_by`. Absent: DEFAULT_MODEL_BY. A run kind that is not listed keeps its default
 * row. Throws naming the key or value on: an unknown run kind or tier key, a class that is not cheap,
 * standard or strong, a tier object missing a tier, or a `retry_up` that is not a boolean.
 */
export function parseModelBy(raw: unknown): ModelTable {
  const src: unknown = raw === undefined ? DEFAULT_MODEL_BY : raw;
  if (!isObject(src)) throw new Error("model_by must be an object");
  const valid = [...MODEL_RUN_KINDS, "retry_up"];
  for (const key of Object.keys(src)) {
    if (!valid.includes(key)) {
      throw new Error(`model_by: unknown run kind "${key}"; valid keys: ${valid.join(", ")}`);
    }
  }
  const retry_up = src.retry_up ?? true;
  if (typeof retry_up !== "boolean") throw new Error(`model_by.retry_up must be true or false, got ${JSON.stringify(retry_up)}`);

  const by = {} as ModelTable["by"];
  for (const kind of MODEL_RUN_KINDS) {
    const entry: unknown = src[kind] ?? DEFAULT_MODEL_BY[kind];
    if (isObject(entry)) {
      for (const key of Object.keys(entry)) {
        if (!(TIER_KEYS as readonly string[]).includes(key)) {
          throw new Error(`model_by.${kind}: unknown tier "${key}"; valid tiers: ${TIER_KEYS.join(", ")}`);
        }
      }
      const row = {} as Record<Tier, ModelClass>;
      for (const t of TIER_KEYS) {
        if (!Object.hasOwn(entry, t)) throw new Error(`model_by.${kind}: tier "${t}" is missing; list all of ${TIER_KEYS.join(", ")}`);
        row[Number(t) as Tier] = classAt(entry[t], `${kind}["${t}"]`);
      }
      by[kind] = row;
    } else {
      const c = classAt(entry, kind);
      by[kind] = { 1: c, 2: c, 3: c, 4: c, 5: c };
    }
  }
  return { by, retry_up };
}

/** Checks `models`: a non-empty model name for each of cheap, standard and strong. Throws naming the missing one. */
export function parseModels(raw: unknown): ModelNames {
  if (!isObject(raw)) throw new Error(`models must be an object with ${MODEL_CLASSES.join(", ")}`);
  const names = {} as ModelNames;
  for (const c of MODEL_CLASSES) {
    const v = raw[c];
    if (typeof v !== "string" || v.trim() === "") throw new Error(`models.${c} must be a model name (non-empty string)`);
    names[c] = v;
  }
  return names;
}

/** The table used when none is configured. */
export const DEFAULT_MODEL_TABLE: ModelTable = parseModelBy(undefined);

/** One class up; strong stays strong. */
export function bumpClass(c: ModelClass): ModelClass {
  return MODEL_CLASSES[Math.min(MODEL_CLASSES.indexOf(c) + 1, MODEL_CLASSES.length - 1)]!;
}

/**
 * The class for an agent run. `tier` null (an item not triaged yet) takes the tier-5 entry. A retry is an
 * implement or resolve run for an item with `loop_count` ≥ 1 (review or failed checks sent it back): it goes
 * one class up when `retry_up` is on. Restart retries do not change `loop_count`, so they are not bumped.
 */
export function modelClassFor(table: ModelTable, kind: ModelRunKind, tier: Tier | null, loopCount: number): ModelClass {
  const base = table.by[kind][tier ?? 5];
  const retry = table.retry_up && loopCount >= 1 && (kind === "implement" || kind === "resolve");
  return retry ? bumpClass(base) : base;
}

/** Whether a run kind runs an agent and so has a model class. */
export function isModelRunKind(kind: RunKind): kind is ModelRunKind {
  return (MODEL_RUN_KINDS as readonly string[]).includes(kind);
}
