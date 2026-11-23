import type { OverCap, SplitLimits } from "./split.js";
import type { Actor, StateChangeDetail, WorkItemPatch } from "./types.js";
import type { LearnedSettingsStore } from "./learned-settings.js";
import type { OverrideSource, SettingsBase } from "./settings.js";

// An item's size caps (design 04-split-specs): the one place a size reader of one item gets `max_diff_lines` and
// `max_diff_files`. An item may carry a one-time cap that replaces the project settings for it alone; without one,
// the project settings apply. Only an over-cap `/approve` writes it (2026-11-24), with its `size_cap_approved` record
// on the same transition. Pure but for `storedProjectCaps`, which reads the store: the caller passes the settings it read.

/** What a size reader needs of an item: its project (whose settings the caller read) and its one-time cap, absent or null for none. */
export interface SizeCapped {
  project: string;
  size_cap?: SplitLimits | null;
}

/** The item's size caps: its one-time cap when it has one, else the project settings' caps. */
export function sizeCaps(item: SizeCapped, settings: SplitLimits): SplitLimits {
  const caps = item.size_cap ?? settings;
  return { max_diff_lines: caps.max_diff_lines, max_diff_files: caps.max_diff_files };
}

/** The detail key, on the transition that applies an over-cap `/approve`, that holds its record (JSON, `SizeCapApproval`). */
export const SIZE_CAP_APPROVED = "size_cap_approved";

/** What an over-cap `/approve` stores: who approved it, the size it approved, the project's caps, the one-time cap and the note saying why. */
export interface SizeCapApproval {
  actor: string;
  sizes: { lines: number; files: number };
  project_cap: SplitLimits;
  one_time_cap: SplitLimits;
  note: string;
}

/** The caps an over-cap approval's refusal names: the size, the caps in force and the proposed one-time cap. */
export interface OverCapSizes {
  readonly sizes: { readonly lines: number; readonly files: number };
  readonly caps: { readonly max_diff_lines: number; readonly max_diff_files: number };
  readonly one_time_cap: { readonly max_diff_lines: number; readonly max_diff_files: number };
}

/**
 * The one refusal of an over-cap `/approve` with no note (design 04-split-specs, 2026-11-24), the same from every
 * source: the size, the caps and the proposed one-time cap, and the reply that approves it. Nothing is stored.
 */
export function overCapNoteRequired(o: OverCapSizes): string {
  return (
    `${o.sizes.lines} lines in ${o.sizes.files} files is over the cap (\`max_diff_lines\` = ${o.caps.max_diff_lines}, ` +
    `\`max_diff_files\` = ${o.caps.max_diff_files}), so approving it needs a note saying why; reply \`/approve <why>\` to approve ` +
    `a one-time cap of ${o.one_time_cap.max_diff_lines} lines and ${o.one_time_cap.max_diff_files} files, so nothing was stored`
  );
}

/** The refusal of an `/approve` at `too_large` whose blocked run recorded no diff size, so no one-time cap can be proposed. */
export const OVER_CAP_NO_SIZE =
  "the blocked implement run recorded no diff size, so no one-time cap can be proposed; reply `/retry` to run it again on the same caps or `/revise <feedback>` for a smaller spec, so nothing was stored";

/**
 * An `/approve` over the caps (`over`, from `overCap` in src/core/split.ts), design 04-split-specs, 2026-11-24: refused
 * with one reply and nothing stored when it has no note (or, at `too_large`, when the blocked run recorded no size); else
 * `d`, the approval's own transition (the spec gate's `spec_approved`, `/retry`'s implement run at `too_large`), with the
 * one-time cap on the item and its `size_cap_approved` record in the detail, so both land in that one transition. Not
 * over the caps, or `d` is no transition (a refusal, nothing to do): `d` as it is.
 */
export function overCapApproval<D extends { refuse: string } | { patch: WorkItemPatch; detail?: StateChangeDetail } | null>(
  over: OverCap | { sizes: null } | null, actor: Actor, note: string | null, d: D,
): D | { refuse: string } {
  if (over === null) return d;
  if (!("at" in over)) return { refuse: OVER_CAP_NO_SIZE };
  const why = note?.trim() ?? "";
  if (why === "") return { refuse: overCapNoteRequired(over) };
  if (d === null || "refuse" in d) return d;
  const record: SizeCapApproval = { actor: actor.id, sizes: over.sizes, project_cap: over.project_cap, one_time_cap: over.one_time_cap, note: why };
  return { ...d, patch: { ...d.patch, size_cap: over.one_time_cap }, detail: { ...d.detail, [SIZE_CAP_APPROVED]: JSON.stringify(record) } };
}

/**
 * A project's caps read from the store outside the controller (the CLI's and the dashboard's over-cap check before
 * anything is stored), as the controller's settings resolve them: the file's layers with the `owner/name` block
 * re-keyed to the configured project's `key`, the stored overrides, then the stored learned layer. The settings
 * modules load when it runs: split.ts loads this file early, and the learned layer's imports lead back to it.
 */
export async function storedProjectCaps(
  store: OverrideSource & Pick<LearnedSettingsStore, "listLearnedSettings">, base: SettingsBase, ownerName: string, key: string | null, project: string,
): Promise<SplitLimits> {
  const [{ resolveSettings, settingValues }, { learnedFromRows }, { rekeyProjectSettings }] = await Promise.all([import("./settings.js"), import("./learned-settings.js"), import("./project.js")]);
  const layers = key ? { ...base.layers, projects: rekeyProjectSettings(base.layers.projects, ownerName, key) } : base.layers;
  const r = resolveSettings({ ...base, layers }, await store.listSettingOverrides());
  return sizeCaps({ project }, settingValues(project, r.layers, learnedFromRows(await store.listLearnedSettings())));
}
