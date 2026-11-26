import { useQueryClient } from "@tanstack/react-query";
import { type RefObject, useRef, useState } from "react";
import { postJson, useApi } from "../api/client.js";
import { type EvalRun, type JudgedCheck, type SkillVersionRow, postEvalRun, postEvalWrite, useEvalCalibration, useEvalRuns, useSkillDiff, useSkillVersions } from "../api/evals.js";
import type { Session } from "../api/overview.js";
import { API } from "../api/routes.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { ButtonRow } from "../components/ui/button-row.js";
import { CARD_INTRO, Card } from "../components/ui/card.js";
import { Chart } from "../components/ui/chart.js";
import { type Column, DataTable } from "../components/ui/data-table.js";
import { Dialog, ModalPanel } from "../components/ui/dialog.js";
import { DiffView } from "../components/ui/diff-view.js";
import { Disclosure } from "../components/ui/disclosure.js";
import { Field } from "../components/ui/field.js";
import { Input } from "../components/ui/input.js";
import { KeyValue } from "../components/ui/key-value.js";
import { ROW_TITLE, ListRow } from "../components/ui/list-row.js";
import { EmptyState, Notice, PageHeader } from "../components/ui/notice.js";
import { ErrorNote, Loading } from "../components/ui/parts.js";
import { Select } from "../components/ui/select.js";
import { Textarea } from "../components/ui/textarea.js";
import { t } from "../i18n/index.js";
import { localDateTime, localShortDate } from "../lib/format.js";

// The evals page at evals/<skill> (design 09-dashboard-evals): the header (title and Run now, the one primary Button), the
// Versions Card (a ListRow per version, newest first, the current one with a Badge, its pass rate, 95% band in words and
// cost per run), the Cases Card (a DataTable: a row per case, a column per version), a ButtonRow with Compare (opens a
// ModalPanel: two version Selects, the unified DiffView of their SKILL.md texts and each case's result) and the Trend Card.
// A case that failed in the newest finished run (its verdict in that run's version row) has "Add as a new case" in the
// Cases table's last column: a Dialog that posts case.from_run (a new dev case copying it) and shows a refusal in it. Plain words only: folder hashes
// and run IDs show only inside a version row's Details. Run now opens a Dialog that starts one run
// (POST /api/v1/evals/<skill>/runs); the server's refusal (403 owner check, 409 refused run) shows in it. A version the
// gate holds is a Card above Versions: its pass rates, the cases that got worse, "Keep the current version" (a Dialog
// with an optional reason, not stored) and "Use this version"; the held-version alarm in Needs you uses the same actions.
// The Judge checks Card comes last: the judge's agreement with the owner's labels (a warn Notice below 80%) and each
// check the judge answered in the newest finished run, with Right and Wrong in a ButtonRow (op label.set).

/** The skill's name from its skill_ref (`skills/review/SKILL.md` → "review"): the last part, not the file's name. */
export function skillName(ref: string): string {
  const parts = ref.split("/").filter(Boolean);
  if (parts.at(-1)?.toLowerCase() === "skill.md") parts.pop();
  return parts.at(-1) ?? ref;
}

const percent = (rate: number): string => `${Math.round(rate * 100)}%`;
const rateText = (rate: number | null): string => (rate === null ? t("evals.noRate") : percent(rate));
const points = (n: number): string => t("evals.points", { sign: n < 0 ? "−" : "+", n: Math.abs(Math.round(n * 100)) });

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

/** The model classes in the order cheap, standard, strong; Run now's model choices. */
const CLASS_ORDER = ["cheap", "standard", "strong"];
/** The class a run's judge uses for `model` (src/core/scorer.ts judgeClass): strong grades the others, standard grades strong. */
const judgeOf = (model: string): string => (model === "strong" ? "standard" : "strong");

/** The change since the previous version as +N points or −N points; a version with no change to show says so. */
const changeText = (change: number | null): string => (change === null ? t("evals.noChange") : t("evals.changeOf", { change: points(change) }));

/** The 95% band of a version's pass rate as words ("between 70% and 90%"); none says so. */
const bandText = (band: SkillVersionRow["band"]): string => (band == null ? t("evals.noBand") : t("evals.bandOf", { low: percent(band.low), high: percent(band.high) }));
/** A version's cost per run in dollars, to the cent (less than a cent shows as "<$0.01"); none says so. */
const costText = (cost: number | null | undefined): string =>
  cost == null ? t("evals.noCost") : t("evals.costOf", { cost: cost > 0 && cost < 0.01 ? "<$0.01" : `$${cost.toFixed(2)}` });

/** One version: Version N, a Badge on the current one, its pass rate, band, cost, change and date; hash and run ID under Details. */
function VersionRow({ v }: { v: SkillVersionRow }) {
  return (
    <ListRow
      data-version={v.version}
      title={<span className="flex items-center gap-2"><span className={ROW_TITLE}>{t("evals.versionN", { n: v.version })}</span>{v.current && <Badge level="succeeded">{t("evals.current")}</Badge>}</span>}
      details={<><span>{t("evals.rateOf", { rate: rateText(v.pass_rate) })}</span><span>{bandText(v.band)}</span><span>{costText(v.cost_usd)}</span><span>{changeText(v.change)}</span><span>{t("evals.versionDate", { date: localShortDate(v.created_at) })}</span></>}
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

interface VersionCasesRow {
  key: string;
  n: number;
  name: string;
  results: Map<number, string | null>;
  /** The case failed in the newest finished run (its verdict in that run's version row). */
  failed: boolean;
}

/**
 * One write from this page: `busy` while it posts; `post` answers the server's refusal (shown as `error`) or null;
 * a throw shows `failed`. On success every read loads again, then `done` runs (a Dialog closes).
 */
function useEvalPost(failed: string) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async (post: () => Promise<string | null>, done?: () => void): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const refused = await post();
      if (refused !== null) return setError(refused);
      await client.invalidateQueries();
      done?.();
    } catch {
      setError(failed);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, send };
}

/** A write's refusal text, or null when it went through. */
const refusalOf = (r: { ok: true } | { ok: false; error: string | null }, fallback: string): string | null => (r.ok ? null : (r.error ?? fallback));

/** "Add as a new case" for one case that failed in `run`: a Dialog that posts case.from_run, then reads the page again. */
function AddFromRun({ run, row }: { run: string; row: VersionCasesRow }) {
  const token = useApi<Session>(API.session, false).data?.csrf_token ?? null;
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const { busy, error, setError, send: post } = useEvalPost(t("evals.fromRunFailed"));
  const send = async () => {
    if (token === null) return;
    await post(async () => refusalOf(await postEvalWrite(token, { op: "case.from_run", run, case: row.key }), t("evals.fromRunFailed")), () => setOpen(false));
  };
  return (
    <>
      <Button ref={button} size="sm" onClick={() => { setError(null); setOpen(true); }}>{t("evals.fromRun")}</Button>
      {open && (
        <Dialog
          title={t("evals.fromRunTitle", { n: row.n })}
          consequence={t("evals.fromRunConsequence", { n: row.n })}
          confirmLabel={busy ? t("evals.fromRunAdding") : t("evals.fromRunConfirm")}
          confirmDisabled={busy || token === null}
          error={error}
          onConfirm={() => void send()}
          onClose={() => setOpen(false)}
          returnFocusTo={button}
        />
      )}
    </>
  );
}

/**
 * One row per case (numbered, never by ID), one column per version newest first; a cell is the case's result in that
 * version. When a case failed in the newest finished run (`run`), a last column holds its "Add as a new case".
 */
function Cases({ versions, run }: { versions: ReturnType<typeof useSkillVersions>; run: string | null }) {
  const list = versions.data?.versions ?? [];
  const ids = [...new Set(list.flatMap((v) => (v.cases ?? []).map((c) => c.case_id)))].sort();
  const newest = run === null ? undefined : list.find((v) => v.run_id === run);
  const rows = ids.map((id, i): VersionCasesRow => ({
    key: id, n: i + 1, name: t("evals.caseN", { n: i + 1 }), results: new Map(list.map((v) => [v.version, v.cases?.find((c) => c.case_id === id)?.verdict ?? null])),
    failed: newest?.cases?.some((c) => c.case_id === id && c.verdict === "fail") ?? false,
  }));
  const columns: Column<VersionCasesRow>[] = [
    { key: "name", header: t("evals.caseColumn") },
    ...list.map((v): Column<VersionCasesRow> => ({ key: `v${v.version}`, header: t("evals.versionN", { n: v.version }), render: (r) => verdictText(r.results.get(v.version) ?? null) })),
    ...(run !== null && rows.some((r) => r.failed) ? [{ key: "actions", header: t("evals.colActions"), render: (r: VersionCasesRow) => (r.failed ? <AddFromRun run={run} row={r} /> : null) }] : []),
  ];
  return (
    <Card title={t("evals.cases")}>
      {versions.isError ? (
        <ErrorNote error={new Error(t("evals.versionsFailed"))} />
      ) : !versions.data ? (
        <Loading rows={3} label="loading.evalRuns" onRetry={() => void versions.refetch()} />
      ) : (
        <DataTable label={t("evals.casesLabel")} columns={columns} rows={rows} rowKey={(r) => r.key} empty={t("evals.casesEmpty")} />
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
        <Button ref={button} data-capture-open="evals-compare" disabled={!enough} title={enough ? undefined : t("evals.compareNeeds")} onClick={() => setOpen(true)}>{t("evals.compare")}</Button>
      </ButtonRow>
      {open && (
        <ModalPanel title={t("evals.compare")} onClose={() => setOpen(false)} returnFocusTo={button}>
          <ComparePanel skill={skill} versions={versions} />
        </ModalPanel>
      )}
    </>
  );
}

/** One case whose pass rate fell in a held version's gate run (GET /api/v1/evals, src/ui/evals-api.ts HeldVersion). */
export interface HeldCase {
  case_id: string;
  input: string | null;
}

/** A skill version the new-version gate holds (design 07-self-improvement), as GET /api/v1/evals lists it. */
export interface HeldVersion {
  ref_id: string;
  version: number;
  skill: string | null;
  pass_rate: number | null;
  before: number | null;
  current_version: number | null;
  fell: HeldCase[];
  alert_id: string | null;
}

/** The held skill versions, newest first, polled so the alarm and the Evals page clear once one is settled. */
export const useHeldVersions = () => useApi<{ skills: string[]; held?: HeldVersion[] }>("/api/v1/evals");

/** Settles one held version through POST /api/v1/evals/write, the store method of a bare `factory approve` / `factory reject`. */
async function postSettle(token: string, h: HeldVersion, decision: "approve" | "reject"): Promise<string | null> {
  const r = await postJson<{ error?: string }>("/api/v1/evals/write", token, { op: "version.settle", ref: h.ref_id, version: h.version, decision });
  return r.ok ? null : (r.value.error ?? t("evals.heldFailed"));
}

/** A held version's pass rate against the current version's, in plain words. */
export const heldRates = (h: HeldVersion): string =>
  h.before === null || h.current_version === null
    ? t("evals.heldRate", { rate: rateText(h.pass_rate) })
    : t("evals.heldRates", { rate: rateText(h.pass_rate), before: percent(h.before), current: h.current_version });

/** The cases that got worse in a held version, one line each (the case's input when it is text, else its number). */
export function HeldCases({ held }: { held: HeldVersion }) {
  if (held.fell.length === 0) return <p className="text-sm text-pretty text-text-2">{t("evals.heldNoneWorse")}</p>;
  return (
    <ul data-held-cases aria-label={t("evals.heldWorse")} className="min-w-0 space-y-0.5 text-sm">
      {held.fell.map((c, i) => (
        <li key={c.case_id} data-case={c.case_id} title={c.input ?? undefined} className="truncate">{c.input ?? t("evals.heldCase", { id: i + 1 })}</li>
      ))}
    </ul>
  );
}

/**
 * "Use this version" (approve) and "Keep the current version" (reject, after a Dialog with an optional reason that is
 * not stored) for one held version. Both post the settle, then reload every read, so the alarm leaves Needs you and the
 * versions list marks the right version current. The buttons never change the row's height: the reason is asked in
 * the Dialog and a refusal shows in it, or (for Use this version) on its own line under the buttons.
 */
export function HeldVersionActions({ held, skill, size = "md" }: { held: HeldVersion; skill: string; size?: "sm" | "md" }) {
  const token = useApi<Session>(API.session, false).data?.csrf_token ?? null;
  const keepButton = useRef<HTMLButtonElement>(null);
  const [keeping, setKeeping] = useState(false);
  const [reason, setReason] = useState("");
  const [on, setOn] = useState<"use" | "keep">("use");
  const { busy, error: refused, setError, send } = useEvalPost(t("evals.heldFailed"));
  const error = refused === null ? null : { on, text: refused };
  const settle = async (decision: "approve" | "reject") => {
    if (token === null) return;
    setOn(decision === "approve" ? "use" : "keep");
    await send(() => postSettle(token, held, decision), () => setKeeping(false));
  };
  return (
    <>
      <ButtonRow data-held-actions>
        <Button ref={keepButton} size={size} disabled={busy || token === null} onClick={() => { setError(null); setKeeping(true); }}>{t("evals.heldKeep")}</Button>
        <Button variant="primary" size={size} disabled={busy || token === null} onClick={() => void settle("approve")}>{t("evals.heldUse")}</Button>
      </ButtonRow>
      {error?.on === "use" && <p data-row-error role="alert" className="text-xs text-pretty break-words text-pill-bad-fg">{error.text}</p>}
      {keeping && (
        <Dialog
          title={t("evals.heldKeepTitle", { skill: skillName(skill) })}
          consequence={t("evals.heldKeepConsequence", { n: held.version })}
          confirmLabel={t("evals.heldKeep")}
          confirmDisabled={busy || token === null}
          error={error?.on === "keep" ? error.text : null}
          onConfirm={() => void settle("reject")}
          onClose={() => { setKeeping(false); setReason(""); }}
          returnFocusTo={keepButton}
        >
          <Field label={t("evals.heldReason")} htmlFor="evals-held-reason" help={t("evals.heldReasonHelp")}>
            <Textarea id="evals-held-reason" rows={3} value={reason} className="w-full" onChange={(e) => setReason(e.target.value)} />
          </Field>
        </Dialog>
      )}
    </>
  );
}

/** The held versions of this skill, each a Card at the top of the page: its rates, the cases that got worse, both actions. */
function HeldVersions({ skill }: { skill: string }) {
  const held = (useHeldVersions().data?.held ?? []).filter((h) => h.skill === skill);
  return held.map((h) => (
    <Card key={`${h.ref_id}:${h.version}`} title={t("evals.heldTitle", { n: h.version })}>
      <div data-held-version={h.version} className="flex flex-col gap-3">
        <p className="text-sm text-pretty">{heldRates(h)}</p>
        <div className="space-y-1">
          <p className="text-sm font-medium">{t("evals.heldWorse")}</p>
          <HeldCases held={h} />
        </div>
        <HeldVersionActions held={h} skill={skill} />
      </div>
    </Card>
  ));
}

/** The judge's agreement with the owner's labels as a whole percentage with the label count; with none, said in words. */
function Agreement({ labels, agreement }: { labels: number; agreement: number | null }) {
  if (agreement === null) return <p className="text-sm text-pretty">{t("evals.agreementNone")}</p>;
  return (
    <>
      <p className="text-sm text-pretty">{t("evals.agreement", { rate: percent(agreement), n: labels })}</p>
      {agreement < 0.8 - 1e-9 && <Notice tone="warn">{t("evals.agreementLow")}</Notice>}
    </>
  );
}

/**
 * One check the judge answered: the check, its case (and replay when a case has more than one) and the judge's answer,
 * then Right and Wrong in a ButtonRow. A press posts label.set and reads the page's data again; a labelled check keeps
 * its first label, so both buttons are off once it has one. A refusal shows on its own line under the buttons.
 */
function JudgeCheckRow({ c, n, replays, token }: { c: JudgedCheck & { run: string }; n: number; replays: boolean; token: string | null }) {
  const { busy, error, send } = useEvalPost(t("evals.labelFailed"));
  const label = async (verdict: "right" | "wrong") => {
    if (token === null) return;
    await send(async () => refusalOf(await postEvalWrite(token, { op: "label.set", run: c.run, case: c.case_id, replay: c.replay, check: c.check, label: verdict }), t("evals.labelFailed")));
  };
  const where = replays ? t("evals.judgeCaseReplay", { n, replay: c.replay }) : t("evals.judgeCase", { n });
  const said = t("evals.judgeSaid", { answer: c.answer === "yes" ? t("evals.answerYes") : c.answer === "no" ? t("evals.answerNo") : c.answer });
  const off = busy || token === null || c.label !== null;
  return (
    <li data-judge-check className="flex flex-col gap-2 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-0.5">
        <p className="text-sm text-pretty break-words">{c.check}</p>
        <p className="flex flex-wrap gap-x-3 text-xs text-text-2">
          <span>{where}</span>
          <span>{said}</span>
          {c.label !== null && <span>{t(c.label === "right" ? "evals.markedRight" : "evals.markedWrong")}</span>}
        </p>
        {c.reason !== undefined && c.reason !== "" && <p className="text-xs text-pretty break-words text-text-2">{t("evals.judgeReason", { reason: c.reason })}</p>}
        {error !== null && <p data-row-error role="alert" className="text-xs text-pretty break-words text-pill-bad-fg">{error}</p>}
      </div>
      <ButtonRow className="shrink-0">
        <Button size="sm" disabled={off} onClick={() => void label("right")}>{t("evals.right")}</Button>
        <Button size="sm" disabled={off} onClick={() => void label("wrong")}>{t("evals.wrong")}</Button>
      </ButtonRow>
    </li>
  );
}

/** The Judge checks Card: the judge's agreement, then each check it answered in the newest finished run. */
function JudgeChecks({ skill }: { skill: string }) {
  const calibration = useEvalCalibration(skill);
  const token = useApi<Session>(API.session, false).data?.csrf_token ?? null;
  const data = calibration.data;
  const cases = [...new Set(data?.checks.map((c) => c.case_id) ?? [])];
  const replays = data?.checks.some((c) => c.replay > 1) ?? false;
  return (
    <Card title={t("evals.judge")}>
      <p className={CARD_INTRO}>{t("evals.judgeIntro")}</p>
      {calibration.isError ? (
        <ErrorNote error={new Error(t("evals.judgeFailed"))} />
      ) : !data ? (
        <Loading rows={3} label="loading.evalRuns" onRetry={() => void calibration.refetch()} />
      ) : (
        <div className="flex flex-col gap-4">
          <Agreement labels={data.labels} agreement={data.agreement} />
          {data.run === null || data.checks.length === 0 ? (
            <EmptyState title={t("evals.judgeEmpty")} />
          ) : (
            <ul aria-label={t("evals.judgeChecksLabel")} className="divide-y divide-border rounded-box border border-border">
              {data.checks.map((c) => (
                <JudgeCheckRow key={JSON.stringify([c.case_id, c.replay, c.check])} c={{ ...c, run: data.run! }} n={cases.indexOf(c.case_id) + 1} replays={replays} token={token} />
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}

/** Run now: model class, its judge class (follows the model) and replay count; the run is stored before it closes. */
function RunNowDialog({ skill, onClose, returnFocusTo }: { skill: string; onClose: () => void; returnFocusTo: RefObject<HTMLButtonElement | null> }) {
  const token = useApi<Session>(API.session, false).data?.csrf_token ?? null;
  const [model, setModel] = useState("standard");
  const [replays, setReplays] = useState("1");
  const { busy, error, send: post } = useEvalPost(t("evals.runFailed"));
  const judge = judgeOf(model);
  const send = async () => {
    if (token === null) return;
    await post(async () => refusalOf(await postEvalRun(token, skill, { model_class: model, judge_model_class: judge, replays: Number(replays) }), t("evals.runFailed")), onClose);
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

/** The evals page of one skill (`skill` is its skill_ref): Run now in the header, then any held version, Versions, Cases, Compare, Trend, Judge checks. */
export function EvalsPage({ skill }: { skill: string }) {
  const runs = useEvalRuns(skill);
  const versions = useSkillVersions(skill);
  const header = <PageHeader title={skillName(skill)} description={t("evals.description")} actions={<RunNow skill={skill} />} />;
  if (runs.isError) return <>{header}<ErrorNote error={new Error(t("evals.loadFailed"))} /></>;
  if (!runs.data) return <>{header}<Loading label="loading.evalRuns" onRetry={() => void runs.refetch()} /></>;
  if (runs.data.runs.length === 0) return <>{header}<EmptyState title={t("evals.empty")} description={t("evals.emptyHelp")} /></>;
  return (
    <>
      {header}
      <div className="flex flex-col gap-6">
        <div>
          <HeldVersions skill={skill} />
          <Versions versions={versions} />
        </div>
        <Cases versions={versions} run={runs.data.runs.find((r) => r.status !== "running")?.id ?? null} />
        <CompareVersions skill={skill} versions={versions.data?.versions ?? []} />
        <Trend runs={runs.data.runs} />
        <JudgeChecks skill={skill} />
      </div>
    </>
  );
}
