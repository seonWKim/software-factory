// The owner's summary (design 08-schedules-actions): what the factory merged, what waits for a decision, what failed
// and what was unusual in one window, built only from store reads the dashboard makes (the Work page's closed and
// Needs-you reads, the overview's finished runs, the Schedules page's schedules and runs), in fixed wording: no model
// call. A window with none of these is no summary (spend alone posts nothing). summaryDeps binds the summary action's
// ports (src/controller/units/schedule/plugins/summary/) to the store, the egress scanner and the live settings.

import type { FactoryStore } from "../interfaces/factory-store.js";
import type { EgressScanner } from "../interfaces/egress-scanner.js";
import { commandState, commandsFor, failedRunKind } from "./commands.js";
import { FAILED_PHASES, phaseOf } from "./phase.js";
import type { ScheduleStore } from "./schedule.js";
import type { Run, Timestamp, WorkItem } from "./types.js";

/** The window one summary covers (the summary action's SummaryWindow, src/controller/units/schedule/plugins/ports.ts). */
export interface SummaryWindow { slot: "morning" | "evening"; since: string; until: string; exclude_schedule: string }
/** A summary's button: the command its line asks for, on its item (null: open the item). */
export interface SummaryButton { work_item_id: string; label: string; command: string | null }
/** A summary as built: fixed-wording text and one button per waiting decision and per failure without a retry. */
export interface SummaryMessage { text: string; buttons: readonly SummaryButton[] }

/** The most rows of each read, as the dashboard's lists read them. */
const READ_LIMIT = 200;

/** The store reads a summary makes, each one the dashboard makes too. Read-only. */
export type SummaryReads = Pick<FactoryStore, "listWorkItemsWhere" | "listRunsFinishedSince" | "getWorkItem"> & Pick<ScheduleStore, "listSchedules" | "listScheduleRuns">;

const inWindow = (at: string, w: SummaryWindow): boolean => at > w.since && at <= w.until;
const titled = (it: WorkItem): string => `${it.title || "(untitled)"} (${it.id})`;
const hhmm = (at: string): string => { const d = new Date(at); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

/** The command a waiting item's button sends: the first that applies in its state (`/approve` at a spec or a merge). */
function decisionButton(it: WorkItem): SummaryButton {
  const first = commandsFor(commandState(it)).find((c) => c.name !== "help");
  return { work_item_id: it.id, label: first ? `/${first.name}` : "Open", command: first ? `/${first.name}` : null };
}

/** The window's summary, or null when it has nothing to report. */
export async function buildSummary(store: SummaryReads, w: SummaryWindow): Promise<SummaryMessage | null> {
  const merged = (await store.listWorkItemsWhere({ stage: "CLOSED", updated_since: w.since as Timestamp, exclude_system: true, limit: READ_LIMIT }))
    .filter((it) => it.merge_sha && inWindow(it.updated_at, w));
  const open = await store.listWorkItemsWhere({ blocked_on: "human", exclude_closed: true, exclude_system: true, limit: READ_LIMIT });
  const waiting = open.filter((it) => !FAILED_PHASES.has(phaseOf(it)));
  const failed = new Map<string, Run>(); // the newest failed run of each item
  for (const r of await store.listRunsFinishedSince({ status: "failed", since: w.since as Timestamp })) if (inWindow(r.finished_at ?? r.updated_at, w)) failed.set(r.work_item_id, r);
  const unusual: string[] = [];
  for (const s of await store.listSchedules({ check_pages: true })) {
    if (s.id === w.exclude_schedule) continue;
    if (s.paused) unusual.push(`- Schedule "${s.title}" is paused: a run went over its run cap.`);
    for (const r of await store.listScheduleRuns(s.id)) {
      if ((r.outcome === "skipped" || r.outcome === "refused") && inWindow(r.recorded_at, w)) unusual.push(`- Schedule "${s.title}" ${r.outcome === "skipped" ? "skipped" : "refused"} its ${hhmm(r.occurrence_at)} slot${r.outcome === "skipped" ? ": the factory was busy" : ": its last run was still running"}.`);
    }
  }
  const buttons: SummaryButton[] = waiting.map(decisionButton);
  const failures: string[] = [];
  for (const run of failed.values()) {
    const it = await store.getWorkItem(run.work_item_id);
    if (!it) continue;
    const retry = it.stage !== "CLOSED" && failedRunKind(it) !== undefined;
    if (retry) buttons.push({ work_item_id: it.id, label: "/retry", command: "/retry" });
    failures.push(`- ${titled(it)}: its ${run.kind} run failed (attempt ${run.attempt}); ${retry ? "it waits for /retry" : "the factory retried it"}.`);
  }
  if (merged.length + waiting.length + failures.length + unusual.length === 0) return null;
  const section = (head: string, lines: readonly string[]) => (lines.length === 0 ? [] : ["", `${head} (${lines.length})`, ...lines]);
  const text = [
    `The factory's ${w.slot} summary, ${hhmm(w.since)} to ${hhmm(w.until)}`,
    ...section("Merged", merged.map((it) => `- ${titled(it)}`)),
    ...section("Waiting for your decision", waiting.map((it) => `- ${titled(it)}: ${decisionButton(it).label}`)),
    ...section("Failed", failures),
    ...section("Unusual", unusual),
  ].join("\n");
  return { text, buttons };
}

/** The owner's chat as the summary posts to it: one outbound delivery keyed `key` (wi_805e builds it); throws while down. */
export type OwnerChatPost = (d: { key: string; text: string; buttons: readonly SummaryButton[] }) => Promise<{ created: boolean }>;
/** The post before the owner's chat channel exists: down, so each run stores its summary on its run row and posts nothing. */
export const NO_OWNER_CHAT: OwnerChatPost = async () => { throw new Error("no owner chat channel is set up yet"); };

/** The summary action's ports: both time settings read now, the store's summary, the egress scan, the owner's chat. */
export const summaryDeps = (d: { store: SummaryReads; scanner: EgressScanner; times: () => { summary_morning_time: string; summary_evening_time: string }; post: OwnerChatPost }) => ({
  times: async () => { const v = d.times(); return { morning: v.summary_morning_time, evening: v.summary_evening_time }; },
  build: (w: SummaryWindow) => buildSummary(d.store, w),
  scan: async (text: string) => { const r = await d.scanner.scan("comment", text); return r.clean ? [] : r.findings.map((f) => f.rule); },
  post: d.post,
});
