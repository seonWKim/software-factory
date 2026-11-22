import { type ReactNode, useState } from "react";
import { type EfficiencyChart, type EfficiencyFigure, type EfficiencyItem, type EfficiencyTierMerges, type EfficiencyWeek, useEfficiency } from "../api/efficiency.js";
import { Button } from "../components/ui/button.js";
import { Card, CardSection } from "../components/ui/card.js";
import { type Column, DataTable } from "../components/ui/data-table.js";
import { LINK_CLASS } from "../components/ui/link-style.js";
import { EmptyState } from "../components/ui/notice.js";
import { ErrorNote, Loading } from "../components/ui/parts.js";
import type { MessageKey } from "../i18n/en.js";
import { locale, t } from "../i18n/index.js";
import { cn } from "../lib/cn.js";
import { duration, tokens } from "../lib/format.js";
import { Link } from "../nav.js";
import { itemPath } from "../pages.js";

// Health's Efficiency tab (design 06-efficiency): finished items per hour, day and week as small bar charts with their
// totals, then the picked week's tokens and time per finished item (median and 90th percentile) with the change from
// the week before, and its slowest and costliest items. Bars are plain elements on token colours, as in Spend; a
// weekly bar is a Button that picks its week (kept in the browser only). Every number is also shown as text. Last, the
// per-tier merge record and whether each tier meets the auto-merge rule (read-only: nothing merges on it yet). The
// picked week also shows what its finished items took from the owner: asks per item, the median wait and the revert rate.

/** A change in whole percent, signed, with a true minus sign: "−18%", "+5%", "0%". */
export const changeText = (n: number): string => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n)}%`;

const usd = (n: number): string => new Intl.NumberFormat(locale(), { style: "currency", currency: "USD" }).format(n);

/** The change beside a figure, "so far" while the week runs; nothing when the week before has no figure. */
function Change({ value, current }: { value: number | null; current: boolean }) {
  if (value === null) return null;
  return <span data-change className="ml-1 text-xs text-text-2 tabular-nums">{t(current ? "efficiency.changeSoFar" : "efficiency.change", { change: changeText(value) })}</span>;
}

/** One small chart: its title and total as text, one bar per period, the first and last period under it. */
function MiniChart({ title, chart, label, selected, onSelect }: {
  title: string;
  chart: EfficiencyChart;
  label(start: string): string;
  selected?: string;
  onSelect?(start: string): void;
}) {
  const max = Math.max(...chart.bars.map((b) => b.count), 0);
  const pct = (n: number): string => `${max === 0 ? 0 : (n / max) * 100}%`;
  return (
    <div data-chart={title} className="min-w-0 rounded-box border border-border bg-surface p-3">
      <p className="text-xs text-text-2">{title}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{t("efficiency.total", { count: chart.total })}</p>
      <ol aria-label={title} className="mt-2 flex h-16 items-end gap-px">
        {chart.bars.map((b) => {
          const text = t("efficiency.bar", { when: label(b.start), count: b.count });
          const bar = <span aria-hidden className={cn("block w-full rounded-t-control bg-accent", selected !== undefined && selected !== b.start && "opacity-40")} style={{ height: pct(b.count) }} />;
          return (
            <li key={b.start} title={text} className="flex h-full min-w-0 flex-1 items-end">
              {onSelect ? (
                <Button variant="ghost" size="sm" aria-pressed={selected === b.start} onClick={() => onSelect(b.start)} className="h-full w-full items-end! px-0!">
                  <span className="sr-only">{text}</span>
                  {bar}
                </Button>
              ) : (
                <>
                  <span className="sr-only">{text}</span>
                  {bar}
                </>
              )}
            </li>
          );
        })}
      </ol>
      <div aria-hidden className="mt-1 flex justify-between gap-2 text-xs text-text-2 tabular-nums">
        <span>{chart.bars[0] && label(chart.bars[0].start)}</span>
        <span>{chart.bars.at(-1) && label(chart.bars.at(-1)!.start)}</span>
      </div>
    </div>
  );
}

const hourLabel = (s: string): string => `${s.slice(11, 16)} UTC`;
const dayLabel = (s: string): string => s.slice(0, 10);

interface Row { key: MessageKey; fig: EfficiencyFigure; format(n: number): string }

/** The picked week's token and time figures, each with its change from the week before. */
function WeekFigures({ week }: { week: EfficiencyWeek }) {
  const cell = (f: EfficiencyFigure, which: "median" | "p90", format: (n: number) => string) => {
    const v = f[which];
    if (v === null) return <span className="text-text-2">{t("efficiency.noData")}</span>;
    return <>{format(v)}<Change value={f[which === "median" ? "median_change" : "p90_change"]} current={week.current} /></>;
  };
  const rows: Row[] = [
    { key: "efficiency.tokens", fig: week.tokens, format: (n) => tokens(Math.round(n)) },
    { key: "efficiency.totalTime", fig: week.total, format: duration },
    { key: "efficiency.agentTime", fig: week.agent, format: duration },
    { key: "efficiency.waitingTime", fig: week.waiting, format: duration },
  ];
  const columns: Column<Row>[] = [
    { key: "figure", header: t("efficiency.figure"), render: (r) => t(r.key) },
    { key: "median", header: t("efficiency.median"), numeric: true, render: (r) => cell(r.fig, "median", r.format) },
    { key: "p90", header: t("efficiency.p90"), numeric: true, render: (r) => cell(r.fig, "p90", r.format) },
  ];
  return (
    <>
      <p data-finished className="mb-2 text-sm tabular-nums">
        {t("efficiency.finishedWeek", { count: week.finished })}
        <Change value={week.finished_change} current={week.current} />
      </p>
      <DataTable label={t("efficiency.perItem")} columns={columns} rows={rows} rowKey={(r) => r.key} empty={t("efficiency.noData")} />
      {week.tokens.not_counted > 0 && <p className="mt-2 text-sm text-text-2 tabular-nums">{t("efficiency.notCountedTokens", { count: week.tokens.not_counted })}</p>}
      {week.agent.not_counted > 0 && <p className="mt-2 text-sm text-text-2 tabular-nums">{t("efficiency.notCountedTime", { count: week.agent.not_counted })}</p>}
    </>
  );
}

/** A week's listed items, each linking to its page with its title and the figure it is ranked by. */
function ItemList({ label, items, figure, empty }: { label: string; items: EfficiencyItem[]; figure(i: EfficiencyItem): string; empty: string }) {
  if (items.length === 0) return <EmptyState title={empty} />;
  return (
    <ol aria-label={label} className="space-y-1 text-sm">
      {items.map((i) => (
        <li key={i.work_item_id} className="flex items-baseline gap-3">
          <Link href={itemPath(i.work_item_id)} className={`min-w-0 flex-1 truncate ${LINK_CLASS}`}>{i.title ?? t("efficiency.untitled")}</Link>
          <span className="tabular-nums text-text-2">{figure(i)}</span>
        </li>
      ))}
    </ol>
  );
}

/** What a week's finished items took from the owner (GET /api/v1/efficiency `week_figures[].owner`). Null: no data. */
interface OwnerFigures {
  merged: number;
  asks: number;
  touches_per_merged: number | null;
  wait_hours_median: number | null;
  revert_rate: number | null;
  reverted_or_fixed: number;
}

/** A share (0–1) as a plain-element bar on token colours, as in Spend; the text beside it carries the number. */
function ShareBar({ share }: { share: number }) {
  return (
    <span aria-hidden className="mt-1 block h-2 w-full overflow-hidden rounded-control bg-surface-2">
      <span className="block h-full bg-accent" style={{ width: `${Math.min(1, share) * 100}%` }} />
    </span>
  );
}

/** Human touches per merged item, median hours waiting on the owner and the revert/fix-forward rate of the picked week. */
function OwnerSection({ owner, week }: { owner: OwnerFigures | undefined; week: string }) {
  if (!owner || owner.merged === 0) return <EmptyState title={t("efficiency.noItems")} />;
  const noData = <span className="text-text-2">{t("efficiency.noData")}</span>;
  const percent = (n: number) => `${Math.round(n * 100)}%`;
  const rows: { key: string; label: MessageKey; value: ReactNode; share?: number | null }[] = [
    {
      key: "touches", label: "efficiency.touches",
      value: owner.touches_per_merged === null ? noData : t("efficiency.touchesValue", { value: owner.touches_per_merged.toFixed(2), asks: owner.asks, merged: owner.merged }),
    },
    { key: "wait", label: "efficiency.ownerWait", value: owner.wait_hours_median === null ? noData : t("efficiency.hours", { value: owner.wait_hours_median.toFixed(1) }) },
    {
      key: "revert", label: "efficiency.revertRate", share: owner.revert_rate,
      value: owner.revert_rate === null ? noData : t("efficiency.revertValue", { value: percent(owner.revert_rate), count: owner.reverted_or_fixed, merged: owner.merged }),
    },
  ];
  return (
    <>
      <p className="mb-2 text-sm text-pretty text-text-2">{t("efficiency.ownerNote", { week })}</p>
      <ul className="space-y-3 text-sm">
        {rows.map((r) => (
          <li key={r.key} data-owner={r.key}>
            <div className="flex items-baseline gap-3">
              <span className="min-w-0 flex-1">{t(r.label, { week })}</span>
              <span className="tabular-nums">{r.value}</span>
            </div>
            {r.share !== undefined && r.share !== null && <ShareBar share={r.share} />}
          </li>
        ))}
      </ul>
    </>
  );
}

const RULE_KEY: Record<EfficiencyTierMerges["rule"], MessageKey> = {
  met: "efficiency.ruleMet",
  not_met: "efficiency.ruleNotMet",
  too_few: "efficiency.ruleTooFew",
  never: "efficiency.ruleNever",
};

/** Tiers 1–5 and untiered: merges in the last 30 days, reverted or fixed forward, verdicts other than accept, the rule. */
function TierMerges({ rows }: { rows: EfficiencyTierMerges[] }) {
  if (rows.every((r) => r.sample === 0)) return <EmptyState title={t("efficiency.noMerges")} />;
  const columns: Column<EfficiencyTierMerges>[] = [
    { key: "tier", header: t("efficiency.tier"), render: (r) => (r.tier === null ? t("efficiency.untiered") : t("efficiency.tierN", { tier: r.tier })) },
    { key: "merged", header: t("efficiency.merged30d"), numeric: true },
    { key: "reverted_or_fixed", header: t("efficiency.revertedOrFixed"), numeric: true },
    { key: "not_accept", header: t("efficiency.notAccept"), numeric: true },
    { key: "rule", header: t("efficiency.rule"), render: (r) => <span data-rule={r.rule}>{t(RULE_KEY[r.rule], { count: r.sample, bad: r.sample_bad, critical: r.sample_critical })}</span> },
  ];
  return (
    <>
      <p className="mb-2 text-sm text-pretty text-text-2">{t("efficiency.mergesNote")}</p>
      <DataTable label={t("efficiency.merges")} columns={columns} rows={rows} rowKey={(r) => String(r.tier)} empty={t("efficiency.noMerges")} />
    </>
  );
}

/** The Efficiency tab: one Card. */
export function EfficiencyTab() {
  const q = useEfficiency();
  const [picked, pick] = useState<string | null>(null);
  const v = q.data;
  return (
    <Card id="efficiency" title={t("efficiency.title")}>
      {q.isError ? <ErrorNote error={q.error} /> : !v ? <Loading rows={4} /> : (() => {
        const weeks = v.week_figures;
        const week = weeks.find((w) => `${w.start}T00:00:00.000Z` === picked) ?? weeks.at(-1)!;
        const weekStart = `${week.start}T00:00:00.000Z`;
        return (
          <>
            <CardSection title={t("efficiency.finished")}>
              <p className="mb-2 text-sm text-pretty text-text-2">{t("efficiency.finishedNote")}</p>
              <div className="grid gap-3 sm:grid-cols-3">
                <MiniChart title={t("efficiency.last24h")} chart={v.hours} label={hourLabel} />
                <MiniChart title={t("efficiency.last14d")} chart={v.days} label={dayLabel} />
                <MiniChart title={t("efficiency.last8w")} chart={v.weeks} label={dayLabel} selected={weekStart} onSelect={pick} />
              </div>
              {v.left_out.total > 0 && <p data-left-out className="mt-2 text-sm text-pretty tabular-nums">{t("efficiency.leftOut", v.left_out)}</p>}
              {v.runs_without_usage > 0 && <p className="mt-2 text-sm text-pretty text-text-2 tabular-nums">{t("efficiency.runsWithoutUsage", { count: v.runs_without_usage })}</p>}
            </CardSection>
            <CardSection title={t(week.current ? "efficiency.weekSoFar" : "efficiency.week", { week: week.start })}>
              <p className="mb-2 text-sm text-pretty text-text-2">{t("efficiency.pickWeek")}</p>
              <WeekFigures week={week} />
            </CardSection>
            <CardSection title={t("efficiency.owner")}>
              <OwnerSection owner={(week as EfficiencyWeek & { owner?: OwnerFigures }).owner} week={week.start} />
            </CardSection>
            <CardSection title={t("efficiency.slowest")}>
              <ItemList label={t("efficiency.slowest")} items={week.slowest} figure={(i) => duration(i.total_ms)} empty={t("efficiency.noItems")} />
            </CardSection>
            <CardSection title={t("efficiency.costliest")}>
              <ItemList label={t("efficiency.costliest")} items={week.costliest} figure={(i) => (i.cost_usd === null ? "" : usd(i.cost_usd))} empty={t("efficiency.noCost")} />
            </CardSection>
            <CardSection title={t("efficiency.merges")}>
              <TierMerges rows={v.merges} />
            </CardSection>
          </>
        );
      })()}
    </Card>
  );
}
