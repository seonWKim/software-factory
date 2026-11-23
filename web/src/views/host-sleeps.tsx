import type { HostSleepRow } from "../api.js";
import { Card } from "../components/ui/card.js";
import { Disclosure } from "../components/ui/disclosure.js";
import { LINK_CLASS } from "../components/ui/link-style.js";
import { EmptyState } from "../components/ui/notice.js";
import { t } from "../i18n/index.js";
import { localClock, runStatusLabel, shortItemId } from "../lib/format.js";
import { Link } from "../nav.js";
import { BASE, itemPath } from "../pages.js";
import { RawDetails, When } from "./common.js";

/** A host sleep's gap in whole minutes, at least 1 (only gaps over 60 s are recorded). */
export const sleptMinutes = (gap_ms: number): number => Math.max(1, Math.round(gap_ms / 60_000));

interface HeldRun {
  work_item_id: string;
  title: string | null;
  status: string;
}

interface SleepGroup {
  woke_at: string;
  gap_ms: number;
  workers: Set<string>;
  /** The runs the sleep held, once each (by run id), with their item, its title and the run's current status. */
  runs: Map<string, HeldRun>;
}

/**
 * One row per sleep event: entries that woke in the same minute (one per worker, milliseconds apart) merge, the gap
 * being the largest and the workers counted once each.
 */
function groupSleeps(sleeps: readonly HostSleepRow[]): SleepGroup[] {
  const groups = new Map<string, SleepGroup>();
  for (const h of sleeps) {
    const minute = Math.floor(Date.parse(h.woke_at) / 60_000);
    const key = Number.isNaN(minute) ? h.woke_at : String(minute);
    const g: SleepGroup = groups.get(key) ?? { woke_at: h.woke_at, gap_ms: 0, workers: new Set<string>(), runs: new Map() };
    g.gap_ms = Math.max(g.gap_ms, h.gap_ms);
    g.workers.add(h.worker_id);
    if (h.run_id && h.work_item_id && h.run_status) g.runs.set(h.run_id, { work_item_id: h.work_item_id, title: h.work_item_title ?? null, status: h.run_status });
    groups.set(key, g);
  }
  return [...groups.values()];
}

/**
 * A held run on one line: its item's title (as stored, `data-raw`; cut with an ellipsis, the full text in `title`) linked
 * to the item, the short ID, then the run's status. No title: the short ID is the link.
 */
function HeldRunLine({ run }: { run: HeldRun }) {
  const short = shortItemId(run.work_item_id);
  return (
    <li className="flex min-w-0 items-baseline gap-x-2">
      <Link href={itemPath(run.work_item_id)} data-row-title data-raw title={run.title ?? undefined} className={`${LINK_CLASS} min-w-0 truncate`}>{run.title ?? short}</Link>
      {run.title !== null && <span className="shrink-0 font-mono text-text-3">{short}</span>}
      <span className="shrink-0 text-text-2">{runStatusLabel(run.status)}</span>
    </li>
  );
}

/** One sleep: how long, when and how many workers paused on one line, the time since at the end; the held runs behind one disclosure. */
function SleepRow({ g, now }: { g: SleepGroup; now: number }) {
  const n = g.workers.size;
  const workers = t(n === 1 ? "health.pausedOne" : "health.pausedMany", { count: n });
  return (
    <li data-testid="host-sleep" className="px-3 py-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm">
        <span className="font-medium tabular-nums">{t("health.sleptFor", { min: sleptMinutes(g.gap_ms) })}</span>
        <span className="tabular-nums text-text-2">{t("health.sleepAt", { time: localClock(g.woke_at), workers })}</span>
        <span className="ml-auto text-xs tabular-nums text-text-2"><When at={g.woke_at} now={now} /></span>
      </div>
      {g.runs.size > 0 && (
        <Disclosure data-testid="host-sleep-runs" summary={g.runs.size === 1 ? t("health.sleepHeldOne") : t("health.sleepHeldMany", { count: g.runs.size })}>
          <ul className="space-y-1 pb-1 pl-5 text-xs">
            {[...g.runs].map(([id, r]) => <HeldRunLine key={id} run={r} />)}
          </ul>
        </Disclosure>
      )}
    </li>
  );
}

/**
 * The Host sleeps section of Health's Runs tab (design 09-health): the keep-awake hint once at the top while a sleep held
 * runs, one compact row per sleep, and every stored entry behind one Details at the end.
 */
export function HostSleeps({ sleeps, now }: { sleeps: readonly HostSleepRow[]; now: number }) {
  const groups = groupSleeps(sleeps);
  return (
    <Card title={t("health.sleeps")} count={groups.length}>
      {groups.length === 0 ? (
        <EmptyState title={t("health.noSleep")} />
      ) : (
        <>
          {groups.some((g) => g.runs.size > 0) && (
            <p data-testid="keep-awake-hint" className="mb-3 text-sm text-text-2">
              {t("health.sleepHint")} <Link href={`${BASE}settings?tab=advanced`} className={LINK_CLASS}>{t("health.sleepHintLink")}</Link>
            </p>
          )}
          <ul aria-label={t("health.sleeps")} className="divide-y divide-border rounded-control border border-border">
            {groups.map((g) => <SleepRow key={g.woke_at} g={g} now={now} />)}
          </ul>
          <RawDetails className="mt-2">
            <code className="font-mono text-xs whitespace-pre-wrap break-all">{sleeps.map((r) => `${r.woke_at} ${r.worker_id} gap_ms=${r.gap_ms}`).join("\n")}</code>
          </RawDetails>
        </>
      )}
    </Card>
  );
}
