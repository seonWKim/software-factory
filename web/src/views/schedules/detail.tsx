import { type ScheduleRow, type ScheduleSuggestionRow, actionText, isCheckPage, isPaused, pageUrl, useScheduleRuns, useScheduleSuggestions } from "../../api.js";
import { Badge } from "../../components/ui/badge.js";
import { SUB_TITLE } from "../../components/ui/card.js";
import { Clamp } from "../../components/ui/clamp.js";
import { type Column, DataTable } from "../../components/ui/data-table.js";
import { ErrorNote, Loading } from "../../components/ui/parts.js";
import { t } from "../../i18n/index.js";
import { groupedInteger } from "../../lib/format.js";
import { repeatsText } from "../../lib/repeats.js";
import { ACTION_ABOUT, ACTION_TEXT, MISSED_TEXT, SUGGESTION_STATE_TEXT, missedOf } from "./labels.js";

// What a schedule does, in plain words (design 09-dashboard-schedules, owner #84 "there's no explanation for each of
// the schedules"): the one line under each title in the table, and the selected schedule's detail Card above its runs,
// laid out as the Routines page's detail (a two-column dl; on a phone each value goes under its name). A Check a page
// schedule's Card ends with its suggestions, read only.

/** The token limit a schedule with none set runs under (SCHEDULE_TOKEN_CAP in src/core/schedule.ts). */
const DEFAULT_TOKEN_CAP = 200_000;

export const when = (at: string) => new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** What Next run says: On each merge for every on-merge schedule, paused or not, else Paused when paused, else the time. */
export const nextText = (s: ScheduleRow): string => (s.trigger === "merge" ? t("schedules.onMerge") : isPaused(s) || s.next_due_at === null ? t("schedules.nextPaused") : when(s.next_due_at));

/** A Check a page schedule's cap in USD, or "No cap". */
const capText = (usd: number | null) => (usd === null ? t("schedules.detail.noCap") : `$${usd}`);

/**
 * One line saying what a schedule does: the first sentence of its text's first line, else (no text) what its action
 * does in general, so every row has a second line and the rows keep one height.
 */
export function summaryOf(s: ScheduleRow): string {
  const line = actionText(s).trim().split("\n")[0]?.trim() ?? "";
  if (line === "") return s.action === null ? t("schedules.actionNone") : t(ACTION_ABOUT[s.action.kind]);
  return /^(.+?[.!?])(\s|$)/.exec(line)?.[1] ?? line;
}

/**
 * The Schedule cell: the title, and under it the summary in one muted line cut with an ellipsis (its full text in the
 * tooltip). The summary takes the column's width (`w-0 min-w-full`) and never widens it, so the row fits a tablet;
 * from lg the cell is at least 12rem wide (18rem from xl), so the line has room.
 */
export function TitleCell({ s }: { s: ScheduleRow }) {
  const summary = summaryOf(s);
  return (
    <span className="flex min-w-0 flex-col lg:min-w-48 xl:min-w-72">
      <span className="truncate">{s.title}</span>
      <span data-summary title={summary} className="w-0 min-w-full truncate text-xs font-normal text-text-2">
        {summary}
      </span>
    </span>
  );
}

/** The selected schedule's detail: what it does (its whole text, clamped with Show more), then its settings, its last and next run and, for a Check a page one, its suggestions. */
export function ScheduleDetail({ s }: { s: ScheduleRow }) {
  const runs = useScheduleRuns(s.id).data?.runs;
  const last = runs?.at(-1)?.occurrence_at;
  const text = actionText(s).trim();
  const page = isCheckPage(s);
  const rows: [string, string][] = [
    [t("schedules.detail.action"), s.action === null ? t("schedules.actionNone") : `${t(ACTION_TEXT[s.action.kind])}. ${t(ACTION_ABOUT[s.action.kind])}`],
    [t("schedules.detail.repeats"), repeatsText(s.cadence)],
    ...(s.cadence === null ? [] : [[t("schedules.detail.zone"), s.zone] as [string, string]]),
    ...(page
      ? [[t("schedules.detail.url"), pageUrl(s)], [t("schedules.detail.runCap"), capText(s.run_cap_usd)], [t("schedules.detail.dailyCap"), capText(s.daily_cap_usd)]] as [string, string][]
      : [
          [t("schedules.missed"), t(MISSED_TEXT[missedOf(s.skip_when_busy)])],
          [t("schedules.detail.tokenCap"), s.token_cap === null ? t("schedules.detail.tokenCapDefault", { n: groupedInteger(DEFAULT_TOKEN_CAP) }) : groupedInteger(s.token_cap)],
        ] as [string, string][]),
    [t("schedules.detail.last"), runs === undefined ? "" : last === undefined ? t("schedules.detail.never") : when(last)],
    [t("schedules.detail.next"), nextText(s)],
  ];
  return (
    <>
      <dl data-schedule-detail className="grid grid-cols-1 gap-x-4 gap-y-0.5 text-sm sm:grid-cols-[max-content_minmax(0,1fr)] sm:gap-y-2">
        <dt className="text-text-2">{t("schedules.detail.what")}</dt>
        <dd className="mb-2 min-w-0 wrap-anywhere sm:mb-0">
          {text === "" ? summaryOf(s) : <Clamp className="whitespace-pre-wrap">{text}</Clamp>}
        </dd>
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-text-2">{k}</dt>
            <dd className="mb-2 min-w-0 wrap-anywhere sm:mb-0">{v}</dd>
          </div>
        ))}
      </dl>
      {page && <Suggestions id={s.id} />}
    </>
  );
}

/** A Check a page schedule's suggestions, read only (accepting, dismissing and snoozing are the CLI's): the text clamped, the state a Badge. */
function Suggestions({ id }: { id: string }) {
  const q = useScheduleSuggestions(id);
  const columns: Column<ScheduleSuggestionRow>[] = [
    { key: "text", header: t("schedules.suggestions.text"), render: (r) => <Clamp className="whitespace-pre-wrap wrap-anywhere">{r.text}</Clamp> },
    { key: "state", header: t("schedules.suggestions.state"), render: (r) => <Badge level={r.state}>{t(SUGGESTION_STATE_TEXT[r.state])}</Badge> },
  ];
  return (
    <div data-schedule-suggestions className="mt-4 space-y-2">
      <h3 className={SUB_TITLE}>{t("schedules.suggestions.label")}</h3>
      {q.isError ? <ErrorNote error={q.error} /> : !q.data ? <Loading rows={2} label="schedules.suggestions.label" onRetry={() => void q.refetch()} /> : (
        <DataTable columns={columns} rows={q.data.suggestions} rowKey={(r) => r.id} label={t("schedules.suggestions.label")} empty={t("schedules.suggestions.empty")} />
      )}
    </div>
  );
}
