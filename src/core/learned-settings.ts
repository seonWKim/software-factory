// The learned settings layer (design 08-settings, 07-self-improvement; issue #497). The daily improve run reads its
// stored report and, when a project's diff_too_large runs reach LEARN_MIN_FAILURES, writes one tighter
// max_diff_lines for the project and window: LEARN_SHARE of the value in force, rounded down, never below 1. The
// write is a conditional update on the stored value with its audit row in the same transaction, so a retry or a
// second worker writes nothing. Values are only ever tightened; a reset (`factory settings reset --learned`) needs
// approve_merge. settingsFor reads the layer through StoredLearnedSettings, a cache LiveSettings.refresh refreshes.

import { IMPROVER, dailyImproveKey } from "./improver.js";
import { errorText, type Logger } from "./log.js";
import { type LearnedSettingsSource, PROJECT_SETTING_KEYS, type ProjectSettingKey, type ProjectSettings, type SettingsLayers, parseSetting, settingsFor } from "./settings.js";
import type { ImproveReport, Run, RunId, Timestamp } from "./types.js";
import type { ResetSettingInput } from "../interfaces/factory-store.js";

/** The one key the factory learns. */
export const LEARNED_KEY = "max_diff_lines" satisfies ProjectSettingKey;
/** The run error code a learned max_diff_lines answers. */
export const LEARNED_FROM_ERROR = "diff_too_large";
/** diff_too_large runs of a project in one daily report before it learns. */
export const LEARN_MIN_FAILURES = 3;
/** A learned value is this share of the value in force (decision 1 of issue #497: 80%), rounded down. */
export const LEARN_SHARE = { num: 4, den: 5 } as const;

/** One learned value. `value` is JSON text. */
export interface LearnedSetting {
  project: string;
  key: string;
  value: string;
  updated_at: Timestamp;
}

/** One audit row of a learned write or reset. `old_value` null: none was stored. `new_value` null: a reset. */
export interface LearnedSettingChange {
  seq: number;
  project: string;
  key: string;
  old_value: string | null;
  new_value: string | null;
  /** The failed runs the value was learned from; empty for a reset. */
  evidence_run_ids: RunId[];
  /** The end of the improve window it was learned from; null for a reset. */
  window_end: Timestamp | null;
  actor: string;
  at: Timestamp;
}

export interface SetLearnedSettingInput {
  project: string;
  key: string;
  /** The stored value (JSON text) the write expects to replace; null: none. */
  expected: string | null;
  /** JSON text. */
  value: string;
  evidence_run_ids: RunId[];
  window_end: Timestamp;
  actor: string;
}

/** The store's learned-settings methods; part of FactoryStore. */
export interface LearnedSettingsStore {
  /** The learned value of (project, key), or null. Read-only. */
  getLearnedSetting(project: string, key: string): Promise<LearnedSetting | null>;
  /** Every learned value, ordered by project, then key. Read-only. */
  listLearnedSettings(): Promise<LearnedSetting[]>;
  /**
   * Stores a learned value when the stored one is still `expected` (null: none) and no audit row exists for
   * (project, key, window_end), with one audit row in the same transaction. Null, with nothing written, otherwise.
   */
  setLearnedSetting(input: SetLearnedSettingInput): Promise<LearnedSettingChange | null>;
  /** Deletes the learned value of (project, key) with one audit row (`new_value` null, no window). Null when none. */
  resetLearnedSetting(input: ResetSettingInput): Promise<LearnedSettingChange | null>;
  /** Audit rows, newest first, at most `limit`. Read-only. */
  listLearnedSettingChanges(limit: number): Promise<LearnedSettingChange[]>;
}

/** The learned layer from stored rows. A row whose key is not per-project or whose value fails its check is left out. */
export function learnedFromRows(rows: readonly LearnedSetting[]): LearnedSettingsSource {
  const values = new Map<string, unknown>();
  for (const r of rows) {
    if (!(PROJECT_SETTING_KEYS as readonly string[]).includes(r.key)) continue;
    try {
      values.set(JSON.stringify([r.project, r.key]), parseSetting(r.key as ProjectSettingKey, JSON.parse(r.value), `learned ${r.key}`));
    } catch {
      // A bad stored value is no learned value: the layers below stay in force.
    }
  }
  return { get: <K extends ProjectSettingKey>(project: string, key: K) => values.get(JSON.stringify([project, key])) as ProjectSettings[K] | undefined };
}

/**
 * The store-backed learned layer: a cache of the stored rows, so `get` stays synchronous. refresh() re-reads them
 * (LiveSettings.refresh calls it); a failed read keeps the values in use. Only a cache: a restart rebuilds it.
 */
export class StoredLearnedSettings implements LearnedSettingsSource {
  private view: LearnedSettingsSource = learnedFromRows([]);

  constructor(private readonly store: Pick<LearnedSettingsStore, "listLearnedSettings">, private readonly log?: Logger) {}

  async refresh(): Promise<void> {
    try {
      this.view = learnedFromRows(await this.store.listLearnedSettings());
    } catch (err) {
      this.log?.warn("learned settings could not be read; keeping the values in use", { error: errorText(err) });
    }
  }

  get<K extends ProjectSettingKey>(project: string, key: K): ProjectSettings[K] | undefined {
    return this.view.get(project, key);
  }
}

/** LEARN_SHARE of `inForce`, rounded down, never below 1. */
export function tighterLimit(inForce: number): number {
  return Math.max(1, Math.floor((inForce * LEARN_SHARE.num) / LEARN_SHARE.den));
}

/** The diff_too_large runs of a report (its groups and one-run patterns), in report order. */
export function learnEvidence(report: Pick<ImproveReport, "groups" | "patterns">): RunId[] {
  return [...report.groups, ...report.patterns].filter((g) => g.error_code === LEARNED_FROM_ERROR).flatMap((g) => g.run_ids);
}

/**
 * The learner, after the improve run stored `report`: only for the daily run (its key is the day's slot of the
 * report's window), and only with LEARN_MIN_FAILURES diff_too_large runs in it. Writes tighterLimit of the value in
 * force (settingsFor with the stored learned value) when that is tighter. Null when nothing was written.
 */
export async function learnFromReport(
  d: { store: Pick<LearnedSettingsStore, "getLearnedSetting" | "setLearnedSetting">; layers: SettingsLayers },
  run: Pick<Run, "idempotency_key">,
  report: Pick<ImproveReport, "project" | "window_end" | "groups" | "patterns">,
): Promise<LearnedSettingChange | null> {
  const { project, window_end } = report;
  if (run.idempotency_key !== dailyImproveKey(project, window_end.slice(0, 10))) return null;
  const evidence = learnEvidence(report);
  if (evidence.length < LEARN_MIN_FAILURES) return null;
  const stored = await d.store.getLearnedSetting(project, LEARNED_KEY);
  const inForce = settingsFor(project, d.layers, learnedFromRows(stored ? [stored] : [])).max_diff_lines.value;
  const value = tighterLimit(inForce);
  if (value >= inForce) return null;
  return d.store.setLearnedSetting({
    project, key: LEARNED_KEY, expected: stored?.value ?? null, value: JSON.stringify(value), evidence_run_ids: evidence, window_end, actor: IMPROVER.id,
  });
}
