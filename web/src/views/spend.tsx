import { API, type SpendDay, type SpendItem, type SpendTotals, type SpendView, useApi } from "../api.js";
import { type Column, DataTable } from "../components/ui/data-table.js";
import { LINK_CLASS } from "../components/ui/link-style.js";
import { ErrorNote, Loading, Section } from "../components/ui/parts.js";
import { locale, t } from "../i18n/index.js";
import { tokens } from "../lib/format.js";
import { Link } from "../nav.js";
import { itemPath } from "../pages.js";

// The Spend page (design 06-spend): what the agent runs cost today, this week and over the last 30 days, one bar
// per UTC day, and the tasks by cost. Every figure is the sum of the runs' stored costs (GET /api/v1/spend); a run
// with no stored cost is counted apart and never shown as $0. One chart, plain elements on token colours.

/** A dollar amount in the active locale ("$12.50"). */
const usd = (n: number): string => new Intl.NumberFormat(locale(), { style: "currency", currency: "USD" }).format(n);

/** Totals of some days. */
function sum(days: readonly SpendDay[]): SpendTotals {
  return days.reduce((a, d) => ({ cost_usd: a.cost_usd + d.cost_usd, tokens: a.tokens + d.tokens, runs: a.runs + d.runs, unknown: a.unknown + d.unknown }), { cost_usd: 0, tokens: 0, runs: 0, unknown: 0 });
}

/** One period's cost and tokens. */
function Total({ label, total }: { label: string; total: SpendTotals }) {
  return (
    <div data-total={label} className="min-w-0 rounded-box border border-border bg-surface p-3">
      <dt className="text-xs text-text-2">{label}</dt>
      <dd className="mt-1 text-lg font-semibold tabular-nums">{usd(total.cost_usd)}</dd>
      <dd className="text-xs text-text-2 tabular-nums">{t("spend.tokens", { tokens: tokens(total.tokens) })}</dd>
    </div>
  );
}

/** One bar per UTC day, scaled to the day that cost most; each bar names its day and cost to a screen reader. */
function DailyChart({ days }: { days: readonly SpendDay[] }) {
  const max = Math.max(...days.map((d) => d.cost_usd), 0);
  return (
    <div>
      <ol aria-label={t("spend.chartLabel")} className="flex h-32 items-end gap-px border-b border-border">
        {days.map((d) => (
          <li key={d.day} data-day={d.day} title={t("spend.bar", { day: d.day, cost: usd(d.cost_usd) })} className="flex h-full min-w-0 flex-1 items-end">
            <span className="sr-only">{t("spend.bar", { day: d.day, cost: usd(d.cost_usd) })}</span>
            <span aria-hidden className="w-full rounded-t-control bg-accent" style={{ height: `${max === 0 ? 0 : (d.cost_usd / max) * 100}%` }} />
          </li>
        ))}
      </ol>
      <div aria-hidden className="mt-1 flex justify-between gap-2 text-xs text-text-2 tabular-nums">
        <span>{days[0]?.day}</span>
        <span>{usd(max)}</span>
        <span>{days.at(-1)?.day}</span>
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

/** Cost and tokens per day and per task over the last 30 UTC days (GET /api/v1/spend). */
export function SpendPage() {
  const q = useApi<SpendView>(API.spend);
  if (q.isError) return <ErrorNote error={q.error} />;
  if (!q.data) return <Loading rows={4} />;
  const v = q.data;
  const unknown = v.total.unknown;
  return (
    <>
      <Section title={t("spend.totals")}>
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Total label={t("spend.today")} total={sum(v.days.filter((d) => d.day === v.today))} />
          <Total label={t("spend.week")} total={sum(v.days.filter((d) => d.day >= v.week_start))} />
          <Total label={t("spend.last30")} total={v.total} />
        </dl>
        <p className="mt-2 text-xs text-pretty text-text-2">{t("spend.note")}</p>
        {unknown > 0 && (
          <p data-testid="spend-unknown" className="mt-1 text-sm text-pretty">
            {t(unknown === 1 ? "spend.unknownOne" : "spend.unknownMany", { count: unknown })}
          </p>
        )}
      </Section>
      <Section title={t("spend.chart")}>
        <DailyChart days={v.days} />
      </Section>
      <Section title={t("spend.tasks")} count={v.items_total}>
        {v.items.length < v.items_total && (
          <p className="mb-2 text-sm text-pretty">{t("spend.tasksCapped", { shown: v.items.length, total: v.items_total })}</p>
        )}
        <DataTable columns={columns()} rows={v.items} rowKey={(r) => r.work_item_id} label={t("spend.tasks")} empty={t("spend.tasksEmpty")} />
      </Section>
    </>
  );
}
