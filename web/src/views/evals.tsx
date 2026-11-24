import { useQueryClient } from "@tanstack/react-query";
import { type RefObject, useRef, useState } from "react";
import { useApi } from "../api/client.js";
import { type EvalRun, type EvalRunSummary, type SkillVersionRow, postEvalRun, useEvalGrid, useEvalRuns, useSkillDiff, useSkillVersions } from "../api/evals.js";
import type { Session } from "../api/overview.js";
import { API } from "../api/routes.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { ButtonRow } from "../components/ui/button-row.js";
import { Card } from "../components/ui/card.js";
import { Chart } from "../components/ui/chart.js";
import { type Column, DataTable } from "../components/ui/data-table.js";
import { Dialog, ModalPanel } from "../components/ui/dialog.js";
import { DiffView } from "../components/ui/diff-view.js";
import { Disclosure } from "../components/ui/disclosure.js";
import { Field } from "../components/ui/field.js";
import { Input } from "../components/ui/input.js";
import { KeyValue } from "../components/ui/key-value.js";
import { ROW_TITLE, ListRow } from "../components/ui/list-row.js";
import { EmptyState, PageHeader } from "../components/ui/notice.js";
import { ErrorNote, Loading } from "../components/ui/parts.js";
import { Select } from "../components/ui/select.js";
import { t } from "../i18n/index.js";
import { localDateTime, localShortDate } from "../lib/format.js";

// The evals page at evals/<skill> (design 09-dashboard-evals): the header (title and Run now, the one primary Button), the
// Versions Card (a ListRow per version, newest first, the current one with a Badge), a ButtonRow with Compare (opens a
// ModalPanel: two version Selects, the unified DiffView of their SKILL.md texts and each case's result), the Grid Card
// (the case results: the newest run per version and model class) and the Trend Card. Plain words only: folder hashes
// and run IDs show only inside a version row's Details. Run now opens a Dialog that starts one run
// (POST /api/v1/evals/<skill>/runs); the server's refusal (403 owner check, 409 refused run) shows in it.

/** The skill's name from its skill_ref (`skills/review/SKILL.md` → "review"): the last part, not the file's name. */
export function skillName(ref: string): string {
  const parts = ref.split("/").filter(Boolean);
  if (parts.at(-1)?.toLowerCase() === "skill.md") parts.pop();
  return parts.at(-1) ?? ref;
}

const percent = (rate: number): string => `${Math.round(rate * 100)}%`;
const rateText = (rate: number | null): string => (rate === null ? t("evals.noRate") : percent(rate));
const points = (n: number): string => t("evals.points", { sign: n < 0 ? "−" : "+", n: Math.abs(Math.round(n * 100)) });

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

/** The model classes in the order cheap, standard, strong, then any other by name; Run now's model choices. */
const CLASS_ORDER = ["cheap", "standard", "strong"];
/** The class a run's judge uses for `model` (src/core/scorer.ts judgeClass): strong grades the others, standard grades strong. */
const judgeOf = (model: string): string => (model === "strong" ? "standard" : "strong");
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

/** The change since the previous version as +N points or −N points; a version with no change to show says so. */
const changeText = (change: number | null): string => (change === null ? t("evals.noChange") : t("evals.changeOf", { change: points(change) }));

/** One version: Version N, a Badge on the current one, its pass rate, change and date; hash and run ID under Details. */
function VersionRow({ v }: { v: SkillVersionRow }) {
  return (
    <ListRow
      data-version={v.version}
      title={<span className="flex items-center gap-2"><span className={ROW_TITLE}>{t("evals.versionN", { n: v.version })}</span>{v.current && <Badge level="succeeded">{t("evals.current")}</Badge>}</span>}
      details={<><span>{t("evals.rateOf", { rate: rateText(v.pass_rate) })}</span><span>{changeText(v.change)}</span><span>{t("evals.versionDate", { date: localShortDate(v.created_at) })}</span></>}
    >
      <Disclosure summary={t("evals.details")} lazy>
        <KeyValue items={[
          { key: "hash", term: t("evals.folderHash"), value: <span className="font-mono break-all">{v.folder_hash}</span> },
          { key: "run", term: t("evals.runId"), value: v.run_id === null ? t("evals.noRunLinked") : <span className="font-mono break-all">{v.run_id}</span> },
        ]} />
      </Disclosure>
    </ListRow>
  );
}

/** The skill's versions, newest first, in one bordered list. */
function Versions({ versions }: { versions: ReturnType<typeof useSkillVersions> }) {
  return (
    <Card title={t("evals.versions")}>
      {versions.isError ? (
        <ErrorNote error={new Error(t("evals.versionsFailed"))} />
      ) : !versions.data ? (
        <Loading rows={3} label="loading.evalRuns" onRetry={() => void versions.refetch()} />
      ) : versions.data.versions.length === 0 ? (
        <EmptyState title={t("evals.versionsEmpty")} />
      ) : (
        <ul aria-label={t("evals.versionsLabel")} className="divide-y divide-border rounded-box border border-border">
          {versions.data.versions.map((v) => <VersionRow key={v.folder_hash} v={v} />)}
        </ul>
      )}
    </Card>
  );
}

interface CaseRow {
  key: string;
  name: string;
  a: string;
  b: string;
}

const VERDICT: Readonly<Record<string, "evals.verdictPass" | "evals.verdictFail" | "evals.verdictErrored">> = { pass: "evals.verdictPass", fail: "evals.verdictFail", errored: "evals.verdictErrored" };
const verdictText = (v: string | null): string => {
  const key = v === null ? undefined : VERDICT[v];
  return v === null ? t("evals.noResult") : key ? t(key) : v;
};

/** The Compare panel's body: two version Selects (the two newest to start), the SKILL.md diff, each case's result in each. */
function ComparePanel({ skill, versions }: { skill: string; versions: readonly SkillVersionRow[] }) {
  const [picked, setPicked] = useState<{ a?: string; b?: string }>({});
  const a = picked.a ?? versions[1]?.folder_hash ?? null;
  const b = picked.b ?? versions[0]?.folder_hash ?? null;
  const diff = useSkillDiff(skill, a, b);
  const options = versions.map((v) => <option key={v.folder_hash} value={v.folder_hash}>{t("evals.versionN", { n: v.version })}</option>);
  const columns: Column<CaseRow>[] = [
    { key: "name", header: t("evals.caseColumn") },
    { key: "a", header: t("evals.first") },
    { key: "b", header: t("evals.second") },
  ];
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-4">
        <Field label={t("evals.first")} htmlFor="evals-first">
          <Select id="evals-first" value={a ?? ""} wrapperClassName="w-48 max-w-full" onChange={(e) => setPicked({ ...picked, a: e.target.value })}>{options}</Select>
        </Field>
        <Field label={t("evals.second")} htmlFor="evals-second">
          <Select id="evals-second" value={b ?? ""} wrapperClassName="w-48 max-w-full" onChange={(e) => setPicked({ ...picked, b: e.target.value })}>{options}</Select>
        </Field>
      </div>
      {diff.isError ? (
        <ErrorNote error={new Error(t("evals.compareFailed"))} />
      ) : diff.data ? (
        <>
          <DiffView label={t("evals.diffLabel")} empty={t("evals.diffEmpty")} lines={diff.data.lines} />
          <DataTable
            label={t("evals.caseResults")}
            columns={columns}
            rows={diff.data.cases.map((c, i): CaseRow => ({ key: c.case_id, name: t("evals.caseN", { n: i + 1 }), a: verdictText(c.a), b: verdictText(c.b) }))}
            rowKey={(r) => r.key}
            empty={t("evals.noCases")}
          />
        </>
      ) : (
        <Loading rows={3} label="loading.evalCompare" onRetry={() => void diff.refetch()} />
      )}
    </div>
  );
}

/** The Compare Button (secondary, in a ButtonRow under the versions): opens the ModalPanel; needs two versions. */
function CompareVersions({ skill, versions }: { skill: string; versions: readonly SkillVersionRow[] }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const enough = versions.length >= 2;
  return (
    <>
      <ButtonRow>
        <Button ref={button} disabled={!enough} title={enough ? undefined : t("evals.compareNeeds")} onClick={() => setOpen(true)}>{t("evals.compare")}</Button>
      </ButtonRow>
      {open && (
        <ModalPanel title={t("evals.compare")} onClose={() => setOpen(false)} returnFocusTo={button}>
          <ComparePanel skill={skill} versions={versions} />
        </ModalPanel>
      )}
    </>
  );
}

/** Run now: model class, its judge class (follows the model) and replay count; the run is stored before it closes. */
function RunNowDialog({ skill, onClose, returnFocusTo }: { skill: string; onClose: () => void; returnFocusTo: RefObject<HTMLButtonElement | null> }) {
  const client = useQueryClient();
  const token = useApi<Session>(API.session, false).data?.csrf_token ?? null;
  const [model, setModel] = useState("standard");
  const [replays, setReplays] = useState("1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const judge = judgeOf(model);
  const send = async () => {
    if (token === null) return;
    setBusy(true);
    setError(null);
    try {
      const r = await postEvalRun(token, skill, { model_class: model, judge_model_class: judge, replays: Number(replays) });
      if (!r.ok) return setError(r.error ?? t("evals.runFailed"));
      await client.invalidateQueries();
      onClose();
    } catch {
      setError(t("evals.runFailed"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={t("evals.runTitle", { skill: skillName(skill) })}
      consequence={t("evals.runConsequence")}
      confirmLabel={busy ? t("evals.running") : t("evals.runConfirm")}
      confirmDisabled={busy || token === null}
      error={error}
      onConfirm={() => void send()}
      onClose={onClose}
      returnFocusTo={returnFocusTo}
    >
      <Field label={t("evals.runModel")} htmlFor="evals-run-model">
        <Select id="evals-run-model" value={model} wrapperClassName="w-full" onChange={(e) => setModel(e.target.value)}>
          {CLASS_ORDER.map((c) => <option key={c} value={c}>{c}</option>)}
        </Select>
      </Field>
      <Field label={t("evals.runJudge")} htmlFor="evals-run-judge" help={t("evals.runJudgeHelp")}>
        <Select id="evals-run-judge" value={judge} wrapperClassName="w-full" disabled onChange={() => {}}>
          <option value={judge}>{judge}</option>
        </Select>
      </Field>
      <Field label={t("evals.runReplays")} htmlFor="evals-run-replays" help={t("evals.runReplaysHelp")}>
        <Input id="evals-run-replays" type="number" min={1} step={1} value={replays} className="w-24" onChange={(e) => setReplays(e.target.value)} />
      </Field>
    </Dialog>
  );
}

/** The header's one primary action: opens the Run now Dialog. */
function RunNow({ skill }: { skill: string }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button ref={button} variant="primary" onClick={() => setOpen(true)}>{t("evals.runNow")}</Button>
      {open && <RunNowDialog skill={skill} onClose={() => setOpen(false)} returnFocusTo={button} />}
    </>
  );
}

/** The evals page of one skill (`skill` is its skill_ref): Run now in the header, then Versions, Compare, Grid, Trend. */
export function EvalsPage({ skill }: { skill: string }) {
  const runs = useEvalRuns(skill);
  const grid = useEvalGrid(skill);
  const versions = useSkillVersions(skill);
  const header = <PageHeader title={skillName(skill)} description={t("evals.description")} actions={<RunNow skill={skill} />} />;
  if (runs.isError || grid.isError) return <>{header}<ErrorNote error={new Error(t("evals.loadFailed"))} /></>;
  if (!runs.data || !grid.data) return <>{header}<Loading label="loading.evalRuns" onRetry={() => { void runs.refetch(); void grid.refetch(); }} /></>;
  if (runs.data.runs.length === 0) return <>{header}<EmptyState title={t("evals.empty")} description={t("evals.emptyHelp")} /></>;
  return (
    <>
      {header}
      <div className="flex flex-col gap-6">
        <Versions versions={versions} />
        <CompareVersions skill={skill} versions={versions.data?.versions ?? []} />
        <Grid rows={grid.data.rows} runs={runs.data.runs} />
        <Trend runs={runs.data.runs} />
      </div>
    </>
  );
}
