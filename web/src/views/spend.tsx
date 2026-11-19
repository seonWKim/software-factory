import { type ReactNode, useState } from "react";
import { API, type SpendDay, type SpendItem, type SpendTotals, type SpendView, useApi } from "../api.js";
import { Button } from "../components/ui/button.js";
import { type Column, DataTable } from "../components/ui/data-table.js";
import { BANNER_LINK_CLASS, LINK_CLASS } from "../components/ui/link-style.js";
import { Tooltip } from "../components/ui/menu.js";
import { ErrorNote, Loading } from "../components/ui/parts.js";
import { locale, t } from "../i18n/index.js";
import { cn } from "../lib/cn.js";
import { tokens } from "../lib/format.js";
import { Link } from "../nav.js";
import { BASE, itemPath } from "../pages.js";
import { Card, CardSection } from "../components/ui/card.js";

// The Spend page (design 06-spend): what the agent runs cost today, this week and over the last 30 days, one bar
// per UTC day, and the tasks by cost. Every figure is the sum of the runs' stored costs (GET /api/v1/spend); a run
// with no stored cost is counted apart and never shown as $0. One chart, Buttons and plain elements on token colours
// (the design system has no chart tokens): a bar's tooltip names its day's top items, a click filters the tasks.

/** A dollar amount in the active locale ("$12.50"). */
const usd = (n: number): string => new Intl.NumberFormat(locale(), { style: "currency", currency: "USD" }).format(n);

/** A budget in the active locale: whole dollars without cents, "$12.50" with them. */
const budgetUsd = (n: number): string => new Intl.NumberFormat(locale(), { style: "currency", currency: "USD", minimumFractionDigits: Number.isInteger(n) ? 0 : 2 }).format(n);

/** Totals of some days. */
function sum(days: readonly SpendDay[]): SpendTotals {
  return days.reduce((a, d) => ({ cost_usd: a.cost_usd + d.cost_usd, tokens: a.tokens + d.tokens, runs: a.runs + d.runs, unknown: a.unknown + d.unknown }), { cost_usd: 0, tokens: 0, runs: 0, unknown: 0 });
}

/** One period's cost and tokens. */
function Total({ label, total, budget }: { label: string; total: SpendTotals; budget?: { text: (spent: string, budget: string) => string; usd: number | null } }) {
  return (
    <div data-total={label} className="min-w-0 rounded-box border border-border bg-surface p-3">
      <dt className="text-xs text-text-2">{label}</dt>
      <dd className="mt-1 text-lg font-semibold tabular-nums">{usd(total.cost_usd)}</dd>
      <dd className="text-xs text-text-2 tabular-nums">{t("spend.tokens", { tokens: tokens(total.tokens) })}</dd>
      {budget && <dd data-budget className="text-xs text-text-2 tabular-nums">{budget.usd === null ? t("spend.noBudget") : budget.text(usd(total.cost_usd), budgetUsd(budget.usd))}</dd>}
    </div>
  );
}

/** The y-axis values: the most a day cost, half of it and 0 (only 0 when nothing cost anything), top first. */
const yTicks = (max: number): number[] => (max > 0 ? [max, max / 2, 0] : [0]);

/** A day's details, shown above its bar: date, cost, runs, tokens and its top items, each linking to its item. */
function DayDetail({ d }: { d: SpendDay }) {
  const facts = [usd(d.cost_usd), t(d.runs === 1 ? "spend.dayRunsOne" : "spend.dayRunsMany", { count: d.runs }), t("spend.tokens", { tokens: tokens(d.tokens) })];
  if (d.unknown > 0) facts.push(t("spend.dayUnknown", { count: d.unknown }));
  return (
    <span className="block space-y-1 text-left">
      <span className="block font-semibold tabular-nums">{d.day}</span>
      <span className="block tabular-nums">{facts.join(" · ")}</span>
      {d.top.length > 0 && (
        <span role="list" aria-label={t("spend.dayTop")} className="block space-y-0.5">
          {d.top.map((it) => (
            <span role="listitem" key={it.work_item_id} className="flex gap-2">
              <Link href={itemPath(it.work_item_id)} className={`min-w-0 flex-1 truncate ${BANNER_LINK_CLASS}`}>{it.title ?? it.work_item_id}</Link>
              <span className="tabular-nums">{usd(it.cost_usd)}</span>
            </span>
          ))}
        </span>
      )}
    </span>
  );
}

/**
 * One bar per UTC day, scaled to the day that cost most, on a y-axis of cost labels with gridlines; the x-axis names
 * only the first and last day. Hover or focus on a bar shows that day's details; a click (or Enter or Space) picks
 * the day, and again lets it go.
 */
function DailyChart({ days, selected, onSelect }: { days: readonly SpendDay[]; selected: string | null; onSelect(day: string | null): void }) {
  const max = Math.max(...days.map((d) => d.cost_usd), 0);
  const pct = (cost: number): string => `${max === 0 ? 0 : (cost / max) * 100}%`;
  const ticks = yTicks(max);
  return (
    <div className="flex gap-2 pt-2">
      <div aria-hidden data-axis="y" className="relative h-32 w-16 shrink-0 text-xs text-text-2 tabular-nums">
        {ticks.map((v, i) => (
          <span key={i} data-tick={i} className="absolute right-0 translate-y-1/2 whitespace-nowrap" style={{ bottom: pct(v) }}>{usd(v)}</span>
        ))}
      </div>
      <div className="min-w-0 flex-1">
        <div className="relative h-32">
          {ticks.map((v, i) => (
            <span key={i} aria-hidden data-gridline={i} className="pointer-events-none absolute inset-x-0 border-t border-dashed border-border" style={{ bottom: pct(v) }} />
          ))}
          <ol aria-label={t("spend.chartLabel")} className="relative flex h-full items-end gap-px">
            {days.map((d, i) => (
              <li key={d.day} data-day={d.day} className="flex h-full min-w-0 flex-1">
                <Tooltip text={<DayDetail d={d} />} align={i < days.length / 3 ? "start" : i >= (2 * days.length) / 3 ? "end" : "center"} className="h-full w-full">
                  <Button variant="ghost" size="sm" aria-pressed={selected === d.day} onClick={() => onSelect(selected === d.day ? null : d.day)} className="h-full w-full items-end! px-0!">
                    <span className="sr-only">{t("spend.bar", { day: d.day, cost: usd(d.cost_usd) })}</span>
                    <span aria-hidden className={cn("w-full rounded-t-control bg-accent", selected !== null && selected !== d.day && "opacity-40")} style={{ height: pct(d.cost_usd) }} />
                  </Button>
                </Tooltip>
              </li>
            ))}
          </ol>
        </div>
        <div aria-hidden data-axis="x" className="mt-1 flex justify-between gap-2 text-xs text-text-2 tabular-nums">
          <span>{days[0]?.day}</span>
          <span>{days.at(-1)?.day}</span>
        </div>
      </div>
    </div>
  );
}

const columns = (): readonly Column<SpendItem>[] => [
  { key: "item", header: t("col.item"), render: (r) => <Link href={itemPath(r.work_item_id)} className={LINK_CLASS}>{r.title ?? r.work_item_id}</Link> },
  { key: "cost", header: t("col.cost"), numeric: true, render: (r) => usd(r.cost_usd) },
  { key: "tokens", header: t("col.tokens"), numeric: true, render: (r) => tokens(r.tokens) },
  { key: "runs", header: t("col.runs"), numeric: true, render: (r) => r.runs },
  { key: "kinds", header: t("col.kinds"), render: (r) => r.kinds.join(", ") },
  // Shown only when some task has runs with no stored cost.
  { key: "unknown", header: t("spend.noCost"), numeric: true, render: (r) => r.unknown || null },
];

/** The tasks by cost: all of the range, or of the picked day only (its own one-day read), with a control to show all. */
function Tasks({ view, day, onClear }: { view: SpendView; day: string | null; onClear(): void }) {
  // With no day picked this is the page's own read, so no second request.
  const q = useApi<SpendView>(day === null ? API.spend : API.spendDay(day));
  const v = day === null ? view : q.data;
  return (
    <CardSection title={t("spend.tasks")} count={v?.items_total}>
      {day !== null && (
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <p className="text-sm text-pretty">{t("spend.filtered", { day })}</p>
          <Button size="sm" onClick={onClear}>{t("spend.showAll")}</Button>
        </div>
      )}
      {q.isError && day !== null ? (
        <ErrorNote error={q.error} />
      ) : !v ? (
        <Loading rows={3} />
      ) : (
        <>
          {v.items.length < v.items_total && (
            <p className="mb-2 text-sm text-pretty">{t("spend.tasksCapped", { shown: v.items.length, total: v.items_total })}</p>
          )}
          <DataTable columns={columns()} rows={v.items} rowKey={(r) => r.work_item_id} label={t("spend.tasks")} empty={day === null ? t("spend.tasksEmpty") : t("spend.dayEmpty", { day })} />
        </>
      )}
    </CardSection>
  );
}

/** The Card Health puts the Spend figures in (its anchor and level-2 heading); the figures are its CardSections. */
function SpendFrame({ children }: { children: ReactNode }) {
  return (
    <Card id="spend" title={t("page.spend")}>
      {children}
    </Card>
  );
}

/** Health's Spend section: cost and tokens per day and per task over the last 30 UTC days (GET /api/v1/spend). Its anchor is `#spend`. */
export function SpendSection() {
  const q = useApi<SpendView>(API.spend);
  // The day picked on the chart: it filters the tasks table only, and stays in the browser.
  const [day, setDay] = useState<string | null>(null);
  if (q.isError) return <SpendFrame><ErrorNote error={q.error} /></SpendFrame>;
  if (!q.data) return <SpendFrame><Loading rows={4} /></SpendFrame>;
  const v = q.data;
  const unknown = v.total.unknown;
  return (
    <SpendFrame>
      <CardSection title={t("spend.totals")}>
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Total label={t("spend.today")} total={sum(v.days.filter((d) => d.day === v.today))} budget={{ usd: v.budgets.daily_usd, text: (spent, budget) => t("spend.budgetToday", { spent, budget }) }} />
          <Total label={t("spend.week")} total={sum(v.days.filter((d) => d.day >= v.week_start))} budget={{ usd: v.budgets.weekly_usd, text: (spent, budget) => t("spend.budgetWeek", { spent, budget }) }} />
          <Total label={t("spend.last30")} total={v.total} />
        </dl>
        <p className="mt-2 text-xs text-pretty text-text-2">{t("spend.note")}</p>
        <p data-testid="spend-budget-note" className="mt-1 text-xs text-pretty text-text-2">
          {t("spend.budgetNote")} <Link href={`${BASE}settings`} className={LINK_CLASS}>{t("spend.budgetLink")}</Link>
        </p>
        {unknown > 0 && (
          <p data-testid="spend-unknown" className="mt-1 text-sm text-pretty">
            {t(unknown === 1 ? "spend.unknownOne" : "spend.unknownMany", { count: unknown })}
          </p>
        )}
      </CardSection>
      <CardSection title={t("spend.chart")}>
        <DailyChart days={v.days} selected={day} onSelect={setDay} />
      </CardSection>
      <Tasks view={v} day={day} onClear={() => setDay(null)} />
    </SpendFrame>
  );
}
