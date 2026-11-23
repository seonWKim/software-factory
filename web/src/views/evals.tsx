import { useState } from "react";
import { type EvalComparison, type EvalRun, type EvalRunSummary, useEvalCompare, useEvalGrid, useEvalRuns } from "../api/evals.js";
import { Badge } from "../components/ui/badge.js";
import { Card } from "../components/ui/card.js";
import { Chart } from "../components/ui/chart.js";
import { type Column, DataTable } from "../components/ui/data-table.js";
import { Field } from "../components/ui/field.js";
import { EmptyState, PageHeader } from "../components/ui/notice.js";
import { ErrorNote, Loading } from "../components/ui/parts.js";
import { Select } from "../components/ui/select.js";
import { t } from "../i18n/index.js";
import { localDateTime, localShortDate } from "../lib/format.js";

// The evals page at evals/<skill> (design 09-dashboard-evals): three read-only Cards in one column, Trend (pass rate by
// run date), Grid (the newest run of each skill version and model class) and Compare (two runs, the gap and the noise
// band). Plain words only: the skill's name, run dates, model classes and pass rates; no run, suite or skill ID shows.
// Nothing here starts a run.

/** The skill's name from its skill_ref (`skills/review/SKILL.md` → "review"): the last part, not the file's name. */
export function skillName(ref: string): string {
  const parts = ref.split("/").filter(Boolean);
  if (parts.at(-1)?.toLowerCase() === "skill.md") parts.pop();
  return parts.at(-1) ?? ref;
}

const percent = (rate: number): string => `${Math.round(rate * 100)}%`;
const rateText = (rate: number | null): string => (rate === null ? t("evals.noRate") : percent(rate));
const points = (n: number, key: "evals.points" | "evals.band"): string => t(key, { sign: n < 0 ? "−" : "+", n: Math.abs(Math.round(n * 100)) });

/** A run's state as the state table's key: a finished run passed or failed, an errored one failed. */
const levelOf = (status: string): string => (status === "passed" ? "succeeded" : status === "errored" ? "failed" : status);

/** Pass rate by run date, oldest first, skipping runs with no pass rate. */
function Trend({ runs }: { runs: readonly EvalRun[] }) {
  const rated = runs.filter((r) => r.pass_rate !== null).reverse();
  return (
    <Card title={t("evals.trend")}>
      {rated.length === 0 ? (
        <EmptyState title={t("evals.trendEmpty")} />
      ) : (
        <Chart
          label={t("evals.trendLabel")}
          max={1}
          points={rated.map((r) => ({ key: r.id, value: r.pass_rate!, caption: localShortDate(r.started_at), text: t("evals.trendPoint", { date: localDateTime(r.started_at), rate: percent(r.pass_rate!) }) }))}
        />
      )}
    </Card>
  );
}

/** The model classes in the order cheap, standard, strong, then any other by name. */
const CLASS_ORDER = ["cheap", "standard", "strong"];
const byClass = (a: string, b: string): number => {
  const [i, j] = [CLASS_ORDER.indexOf(a), CLASS_ORDER.indexOf(b)];
  return i < 0 && j < 0 ? a.localeCompare(b) : i < 0 ? 1 : j < 0 ? -1 : i - j;
};

interface GridRow {
  key: string;
  version: string;
  cells: Map<string, EvalRunSummary>;
}

/** One row per version, named by its order: the first version the skill had is "Version 1". */
function gridRows(rows: readonly EvalRunSummary[], runs: readonly EvalRun[]): GridRow[] {
  const first = new Map<string, string>();
  for (const r of runs) if (r.skill_version !== null && (first.get(r.skill_version) ?? "￿") > r.started_at) first.set(r.skill_version, r.started_at);
  const order = [...first].sort((a, b) => (a[1] < b[1] ? -1 : 1)).map(([v]) => v);
  const out = new Map<string, GridRow>();
  for (const r of rows) {
    const key = r.skill_version ?? "";
    const row = out.get(key) ?? { key, version: r.skill_version === null ? t("evals.versionUnknown") : t("evals.versionN", { n: order.indexOf(r.skill_version) + 1 }), cells: new Map() };
    row.cells.set(r.model_class ?? "", r);
    out.set(key, row);
  }
  return [...out.values()];
}

/** One row per skill version, one column per model class; a pair with no run says so. */
function Grid({ rows, runs }: { rows: readonly EvalRunSummary[]; runs: readonly EvalRun[] }) {
  const classes = [...new Set(rows.map((r) => r.model_class).filter((c): c is string => c !== null))].sort(byClass);
  const columns: Column<GridRow>[] = [
    { key: "version", header: t("evals.version") },
    ...classes.map((c): Column<GridRow> => ({
      key: c,
      header: c,
      render: (row) => {
        const run = row.cells.get(c);
        if (!run) return <span className="text-text-2">{t("evals.noRun")}</span>;
        return (
          <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1" data-cell>
            <Badge level={levelOf(run.status)}>{rateText(run.pass_rate)}</Badge>
            <span className="text-xs text-text-2">{localShortDate(run.started_at)}</span>
          </span>
        );
      },
    })),
  ];
  return (
    <Card title={t("evals.grid")}>
      <DataTable label={t("evals.grid")} columns={columns} rows={gridRows(rows, runs)} rowKey={(r) => r.key} empty={t("evals.gridEmpty")} />
    </Card>
  );
}

interface CompareRow {
  key: string;
  figure: string;
  a?: string;
  b?: string;
  diff?: string;
}

/** The comparison's figures as rows; the gap and the noise band are under Difference. */
function compareRows(c: EvalComparison): CompareRow[] {
  const model = (r: EvalRunSummary) => r.model_class ?? t("evals.modelUnknown");
  const rows: CompareRow[] = [
    { key: "date", figure: t("evals.runDate"), a: localDateTime(c.a.started_at), b: localDateTime(c.b.started_at) },
    { key: "model", figure: t("evals.modelClass"), a: model(c.a), b: model(c.b) },
    { key: "rate", figure: t("evals.passRate"), a: rateText(c.a.pass_rate), b: rateText(c.b.pass_rate), ...(c.gap !== null && { diff: points(c.gap, "evals.points") }) },
  ];
  if (c.noise_band === null || c.within_noise === null) return [...rows, { key: "none", figure: t("evals.withinNoise"), diff: t("evals.noGap") }];
  return [...rows, { key: "band", figure: t("evals.noiseBand"), diff: points(c.noise_band, "evals.band") }, { key: "within", figure: t("evals.withinNoise"), diff: t(c.within_noise ? "evals.yes" : "evals.no") }];
}

/** Two run pickers and a table of both runs, the gap, the noise band and whether the gap is within noise. */
function Compare({ skill, runs }: { skill: string; runs: readonly EvalRun[] }) {
  // The runs with a pass rate, newest first: the first run starts as the older of the two newest, the second as the newest.
  const rated = runs.filter((r) => r.pass_rate !== null);
  const [picked, setPicked] = useState<{ a?: string; b?: string }>({});
  const a = picked.a ?? rated[1]?.id ?? null;
  const b = picked.b ?? rated[0]?.id ?? null;
  const comparison = useEvalCompare(skill, a, b);
  const options = rated.map((r) => (
    <option key={r.id} value={r.id}>{t("evals.pick", { date: localDateTime(r.started_at), model: r.model_class ?? t("evals.modelUnknown"), rate: percent(r.pass_rate!) })}</option>
  ));
  const columns: Column<CompareRow>[] = [
    { key: "figure", header: t("evals.figure") },
    { key: "a", header: t("evals.first") },
    { key: "b", header: t("evals.second") },
    { key: "diff", header: t("evals.difference") },
  ];
  if (rated.length < 2) {
    return (
      <Card title={t("evals.compare")}>
        <EmptyState title={t("evals.compareEmpty")} />
      </Card>
    );
  }
  return (
    <Card title={t("evals.compare")}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-4">
          <Field label={t("evals.first")} htmlFor="evals-first">
            <Select id="evals-first" value={a ?? ""} wrapperClassName="w-72 max-w-full" onChange={(e) => setPicked({ ...picked, a: e.target.value })}>{options}</Select>
          </Field>
          <Field label={t("evals.second")} htmlFor="evals-second">
            <Select id="evals-second" value={b ?? ""} wrapperClassName="w-72 max-w-full" onChange={(e) => setPicked({ ...picked, b: e.target.value })}>{options}</Select>
          </Field>
        </div>
        {comparison.isError ? (
          <ErrorNote error={new Error(t("evals.loadFailed"))} />
        ) : comparison.data ? (
          <DataTable label={t("evals.compare")} columns={columns} rows={compareRows(comparison.data)} rowKey={(r) => r.key} empty={t("evals.compareEmpty")} />
        ) : (
          <Loading rows={3} />
        )}
      </div>
    </Card>
  );
}

/** The evals page of one skill (`skill` is its skill_ref): Trend, Grid, Compare. */
export function EvalsPage({ skill }: { skill: string }) {
  const runs = useEvalRuns(skill);
  const grid = useEvalGrid(skill);
  const header = <PageHeader title={skillName(skill)} description={t("evals.description")} />;
  if (runs.isError || grid.isError) return <>{header}<ErrorNote error={new Error(t("evals.loadFailed"))} /></>;
  if (!runs.data || !grid.data) return <>{header}<Loading /></>;
  if (runs.data.runs.length === 0) return <>{header}<EmptyState title={t("evals.empty")} description={t("evals.emptyHelp")} /></>;
  return (
    <>
      {header}
      <div className="flex flex-col gap-6">
        <Trend runs={runs.data.runs} />
        <Grid rows={grid.data.rows} runs={runs.data.runs} />
        <Compare skill={skill} runs={runs.data.runs} />
      </div>
    </>
  );
}
