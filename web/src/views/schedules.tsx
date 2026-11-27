import { Pause, Pencil, Play, Trash2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { API, type ScheduleFields, type ScheduleRow, type ScheduleRunRow, type ScheduleVerb, type Session, isPaused, postSchedule, useApi, useScheduleRuns, useSchedules } from "../api.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Card } from "../components/ui/card.js";
import { type Column, DataTable } from "../components/ui/data-table.js";
import { OverflowMenu } from "../components/ui/menu.js";
import { Notice, PageHeader } from "../components/ui/notice.js";
import { ErrorNote, Loading } from "../components/ui/parts.js";
import { Switch } from "../components/ui/switch.js";
import { LINK_CLASS } from "../components/ui/link-style.js";
import { t } from "../i18n/index.js";
import { Link } from "../nav.js";
import { BASE } from "../pages.js";
import { SCHEDULE_ACTOR } from "./activity/page.js";
import { DeleteScheduleDialog, ScheduleDialog, newScheduleId } from "./schedules/form.js";
import { RunOutput } from "./schedules/output.js";
import { ScheduleDetail, TitleCell, nextText, when } from "./schedules/detail.js";
import { repeatsText } from "../lib/repeats.js";
import { ACTION_TEXT, OUTCOME_TEXT, STATE_TEXT } from "./schedules/labels.js";

// The Schedules page (design 09-dashboard-schedules, over 08-schedules): every schedule in a DataTable inside a Card,
// read through GET /api/v1/schedules, Check a page schedules too. Repeats reads in plain words through the shared formatter
// (lib/repeats.ts); an On each merge schedule's Repeats and Next run say On each merge, a paused schedule's Next run says
// Paused. Each row's Switch is on while the schedule is not paused (a Check a page one's `paused` flag; for any other,
// pause clears the next run), and posts pause or resume; its "⋯" menu holds Run now (off while paused or on each merge), Edit,
// Pause or Resume, a separator and Delete (danger). Delete, there or in the detail Card's title row,
// asks in a danger Dialog; once it is gone the list rereads, the detail Card closes and the focus goes to the table.
// Each title has one muted line under it saying what the schedule does (schedules/detail.tsx). Pressing a row's title
// (DataTable's `select`) marks the row as current and shows a detail Card (what it does, its settings, its last and next
// run) above its runs (GET /api/v1/schedules/runs). New schedule, the page's one primary action, and Edit open one Dialog
// (schedules/form.tsx). A refusal shows in a Notice above the table.
// The Cards follow the PageHeader as siblings, spaced by the Card's own top margin as on the other pages (no flex gap).

const stateOf = (s: ScheduleRow) => (isPaused(s) ? "paused" : s.running_since !== null ? "running" : "waiting");

/** The writes the page sends, with the one error they share and a reread after each. */
function useScheduleWrites() {
  const client = useQueryClient();
  const token = useApi<Session>(API.session, false).data?.csrf_token ?? null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const write = async (verb: ScheduleVerb, id: string, fields?: ScheduleFields): Promise<boolean> => {
    if (token === null || busy) return false;
    setBusy(true);
    setError(null);
    try {
      const r = await postSchedule(token, verb, id, fields);
      if (!r.ok) {
        setError(r.error);
        return false;
      }
      await client.invalidateQueries({ predicate: (q) => typeof q.queryKey[0] === "string" && q.queryKey[0].startsWith(API.schedules) });
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { ready: token !== null, busy, error, setError, write };
}

type Writes = ReturnType<typeof useScheduleWrites>;
type Opener = HTMLElement | null;

function RunsTable({ id }: { id: string }) {
  const q = useScheduleRuns(id);
  if (q.isError) return <ErrorNote error={q.error} />;
  if (!q.data) return <Loading rows={2} label="loading.scheduleRuns" onRetry={() => void q.refetch()} />;
  const columns: Column<ScheduleRunRow>[] = [
    { key: "started", header: t("schedules.runs.started"), render: (r) => when(r.occurrence_at) },
    { key: "result", header: t("schedules.runs.result"), render: (r) => t(OUTCOME_TEXT[r.outcome]) },
    { key: "cost", header: t("schedules.runs.cost"), render: (r) => (r.cost_usd === undefined ? "" : `$${r.cost_usd.toFixed(4)}`) },
    { key: "transcript", header: "", render: (r) => (r.transcript ? <Link href={r.transcript} className={LINK_CLASS} aria-label={t("schedules.runs.transcriptFor", { at: r.occurrence_at })}>{t("schedules.runs.transcript")}</Link> : null) },
    { key: "output", header: t("schedules.runs.output"), render: (r) => <RunOutput output={r.output} />, className: "max-w-prose break-words" },
  ];
  return <DataTable columns={columns} rows={[...q.data.runs].reverse()} rowKey={(r) => r.occurrence_at} label={t("schedules.runs.label")} empty={t("schedules.runsEmpty")} />;
}

function ScheduleRows({ rows, selected, onSelect, onEdit, onDelete, w }: {
  rows: readonly ScheduleRow[]; selected: string | null; onSelect: (id: string) => void; onEdit: (s: ScheduleRow, opener: Opener) => void; onDelete: (s: ScheduleRow, opener: Opener) => void; w: Writes;
}) {
  const columns: Column<ScheduleRow>[] = [
    { key: "title", header: t("schedules.col.title"), render: (s) => <TitleCell s={s} /> },
    { key: "cadence", header: t("schedules.col.cadence"), render: (s) => repeatsText(s.cadence) },
    { key: "next", header: t("schedules.col.next"), render: nextText },
    { key: "status", header: t("schedules.col.status"), render: (s) => <Badge level={stateOf(s)}>{t(STATE_TEXT[stateOf(s)])}</Badge> },
    { key: "action", header: t("schedules.col.action"), render: (s) => (s.action === null ? t("schedules.actionNone") : t(ACTION_TEXT[s.action.kind])) },
    {
      key: "active",
      header: t("schedules.col.active"),
      render: (s) => (
        <Switch checked={!isPaused(s)} disabled={!w.ready || w.busy} aria-label={t("schedules.switch", { title: s.title })} onCheckedChange={(on) => void w.write(on ? "resume" : "pause", s.id)} />
      ),
    },
    {
      key: "more",
      header: t("schedules.col.more"),
      render: (s) => (
        <OverflowMenu
          label={t("schedules.more", { title: s.title })}
          items={[
            { label: t("schedules.runNow"), icon: Play, action: "schedule run", disabled: isPaused(s) || s.trigger === "merge" || !w.ready, onSelect: () => void w.write("run", s.id) },
            { label: t("schedules.edit"), icon: Pencil, action: "schedule edit", disabled: !w.ready, onSelect: () => onEdit(s, document.activeElement as Opener) },
            isPaused(s)
              ? { label: t("schedules.resume"), icon: Play, action: "schedule resume", disabled: !w.ready, onSelect: () => void w.write("resume", s.id) }
              : { label: t("schedules.pause"), icon: Pause, action: "schedule pause", disabled: !w.ready, onSelect: () => void w.write("pause", s.id) },
            { separator: true },
            { label: t("schedules.delete"), icon: Trash2, danger: true, action: "schedule delete", disabled: !w.ready, onSelect: () => onDelete(s, document.activeElement as Opener) },
          ]}
        />
      ),
    },
  ];
  return <DataTable columns={columns} rows={rows} rowKey={(s) => s.id} label={t("schedules.listLabel")} empty={t("schedules.empty")} dataKey select={{ key: selected, onSelect, label: (s) => t("schedules.select", { title: s.title }) }} />;
}

type FormState = { kind: "edit"; schedule: ScheduleRow | null } | { kind: "delete"; schedule: ScheduleRow };

export function SchedulesPage() {
  const q = useSchedules();
  const w = useScheduleWrites();
  const [selected, setSelected] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const opener = useRef<Opener>(null);
  const table = useRef<HTMLDivElement>(null);
  // Set by a delete: once its Dialog is gone (which gives the focus back only to an opener still on the page), the table takes it.
  const [toTable, setToTable] = useState(false);
  useEffect(() => {
    if (!toTable || form !== null) return;
    table.current?.focus({ preventScroll: true });
    setToTable(false);
  }, [toTable, form]);
  const rows = q.data?.schedules ?? [];
  const chosen = rows.find((s) => s.id === selected) ?? null;
  const close = () => {
    w.setError(null);
    setForm(null);
  };
  const open = (f: FormState, el: Opener) => {
    opener.current = el;
    w.setError(null);
    setForm(f);
  };
  const remove = (s: ScheduleRow) =>
    void w.write("delete", s.id).then((ok) => {
      if (!ok) return;
      if (selected === s.id) setSelected(null);
      setToTable(true);
      close();
    });
  return (
    <>
      <PageHeader
        title={t("page.schedules")}
        description={t("schedules.description")}
        actions={(
          <div className="flex items-center gap-4">
            <Link href={`${BASE}health?tab=activity&actor=${SCHEDULE_ACTOR}`} className={LINK_CLASS}>{t("schedules.activityLink")}</Link>
            <Button ref={addButton} variant="primary" data-capture-open="new-schedule" disabled={!w.ready} onClick={() => open({ kind: "edit", schedule: null }, addButton.current)}>{t("schedules.new")}</Button>
          </div>
        )}
      />
      {form?.kind === "delete" && (
        <DeleteScheduleDialog schedule={form.schedule} busy={w.busy} error={w.error} returnFocusTo={opener} onConfirm={() => remove(form.schedule)} onClose={close} />
      )}
      {form?.kind === "edit" && (
        <ScheduleDialog
          schedule={form.schedule}
          busy={w.busy}
          error={w.error}
          returnFocusTo={opener}
          onSave={(fields) => (form.schedule === null ? w.write("add", newScheduleId(fields.title ?? "", rows.map((s) => s.id)), fields) : w.write("edit", form.schedule.id, fields))}
          onClose={close}
        />
      )}
      <Card label={t("schedules.listLabel")}>
        <div ref={table} tabIndex={-1} data-schedules-table className="space-y-3 outline-none">
          {form === null && w.error !== null && <Notice tone="bad">{w.error}</Notice>}
          {q.isError ? <ErrorNote error={q.error} /> : !q.data ? <Loading rows={3} label="loading.schedules" onRetry={() => void q.refetch()} /> : (
            <ScheduleRows
              rows={rows}
              selected={selected}
              onSelect={setSelected}
              onEdit={(s, el) => open({ kind: "edit", schedule: s }, el)}
              onDelete={(s, el) => open({ kind: "delete", schedule: s }, el)}
              w={w}
            />
          )}
        </div>
      </Card>
      {chosen !== null && (
        <Card
          title={chosen.title}
          label={t("schedules.detail.label", { title: chosen.title })}
          action={
            <Button size="sm" variant="danger" data-action="schedule delete" aria-label={t("schedules.delete.label", { title: chosen.title })} disabled={!w.ready} onClick={(e) => open({ kind: "delete", schedule: chosen }, e.currentTarget)}>
              {t("schedules.delete")}
            </Button>
          }
        >
          <ScheduleDetail key={chosen.id} s={chosen} />
        </Card>
      )}
      <Card title={chosen === null ? t("schedules.runs.label") : t("schedules.runsTitle", { title: chosen.title })}>
        {chosen === null ? <p className="text-sm text-text-2">{t("schedules.runsPick")}</p> : <RunsTable key={chosen.id} id={chosen.id} />}
      </Card>
    </>
  );
}
