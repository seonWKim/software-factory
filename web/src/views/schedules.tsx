import { CalendarClock } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { API, type ScheduleFields, type ScheduleRow, type ScheduleRunRow, type ScheduleVerb, type Session, postSchedule, useApi, useScheduleRuns, useSchedules } from "../api.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Card } from "../components/ui/card.js";
import { type Column, DataTable } from "../components/ui/data-table.js";
import { OverflowMenu } from "../components/ui/menu.js";
import { Notice, PageHeader } from "../components/ui/notice.js";
import { ErrorNote, Loading } from "../components/ui/parts.js";
import { Switch } from "../components/ui/switch.js";
import { t } from "../i18n/index.js";
import { ScheduleDialog, newScheduleId } from "./schedules/form.js";
import { repeatsText } from "../lib/repeats.js";
import { ACTION_TEXT, OUTCOME_TEXT, STATE_TEXT } from "./schedules/labels.js";

// The Schedules page (design 09-dashboard-schedules, over 08-schedules): every schedule in a DataTable inside a Card,
// read through GET /api/v1/schedules. Repeats reads in plain words through the shared formatter (lib/repeats.ts, as on
// Routines); a paused schedule's Next run says Paused. Each row's Switch is on while the schedule has a next run and off while it is
// paused (pause clears the next run), and posts pause or resume; its "⋯" menu holds Run now (off while paused) and Edit.
// Pressing a row's title (DataTable's `select`) marks the row as current and shows its runs in a second Card
// (GET /api/v1/schedules/runs). New schedule, the page's one primary action, and Edit open one Dialog
// (schedules/form.tsx). A refusal shows in a Notice above the table.
// The Cards follow the PageHeader as siblings, spaced by the Card's own top margin as on the other pages (no flex gap).

const when = (at: string) => new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const stateOf = (s: ScheduleRow) => (s.next_due_at === null ? "paused" : s.running_since !== null ? "running" : "waiting");

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

function RunsTable({ id }: { id: string }) {
  const q = useScheduleRuns(id);
  if (q.isError) return <ErrorNote error={q.error} />;
  if (!q.data) return <Loading rows={2} label="loading.scheduleRuns" onRetry={() => void q.refetch()} />;
  const columns: Column<ScheduleRunRow>[] = [
    { key: "started", header: t("schedules.runs.started"), render: (r) => when(r.occurrence_at) },
    { key: "result", header: t("schedules.runs.result"), render: (r) => t(OUTCOME_TEXT[r.outcome]) },
    { key: "cost", header: t("schedules.runs.cost"), render: (r) => (r.cost_usd === undefined ? "" : `$${r.cost_usd.toFixed(4)}`) },
    { key: "output", header: t("schedules.runs.output"), render: (r) => r.output ?? "", className: "max-w-prose break-words whitespace-pre-wrap" },
  ];
  return <DataTable columns={columns} rows={[...q.data.runs].reverse()} rowKey={(r) => r.occurrence_at} label={t("schedules.runs.label")} empty={t("schedules.runsEmpty")} />;
}

function ScheduleRows({ rows, selected, onSelect, onEdit, w }: { rows: readonly ScheduleRow[]; selected: string | null; onSelect: (id: string) => void; onEdit: (s: ScheduleRow, opener: HTMLElement | null) => void; w: Writes }) {
  const columns: Column<ScheduleRow>[] = [
    { key: "title", header: t("schedules.col.title") },
    { key: "cadence", header: t("schedules.col.cadence"), render: (s) => repeatsText(s.cadence), className: "whitespace-nowrap" },
    { key: "next", header: t("schedules.col.next"), render: (s) => (s.next_due_at === null ? t("schedules.nextPaused") : when(s.next_due_at)) },
    { key: "status", header: t("schedules.col.status"), render: (s) => <Badge level={stateOf(s)}>{t(STATE_TEXT[stateOf(s)])}</Badge> },
    { key: "action", header: t("schedules.col.action"), render: (s) => (s.action === null ? t("schedules.actionNone") : t(ACTION_TEXT[s.action.kind])) },
    {
      key: "active",
      header: t("schedules.col.active"),
      render: (s) => (
        <Switch checked={s.next_due_at !== null} disabled={!w.ready || w.busy} aria-label={t("schedules.switch", { title: s.title })} onCheckedChange={(on) => void w.write(on ? "resume" : "pause", s.id)} />
      ),
    },
    {
      key: "more",
      header: t("schedules.col.more"),
      render: (s) => (
        <OverflowMenu
          label={t("schedules.more", { title: s.title })}
          items={[
            { label: t("schedules.runNow"), action: "schedule run", disabled: s.next_due_at === null || !w.ready, onSelect: () => void w.write("run", s.id) },
            { label: t("schedules.edit"), action: "schedule edit", disabled: !w.ready, onSelect: () => onEdit(s, document.activeElement as HTMLElement | null) },
          ]}
        />
      ),
    },
  ];
  return <DataTable columns={columns} rows={rows} rowKey={(s) => s.id} label={t("schedules.listLabel")} empty={t("schedules.empty")} dataKey select={{ key: selected, onSelect, label: (s) => t("schedules.select", { title: s.title }) }} />;
}

export function SchedulesPage() {
  const q = useSchedules();
  const w = useScheduleWrites();
  const [selected, setSelected] = useState<string | null>(null);
  const [form, setForm] = useState<{ schedule: ScheduleRow | null } | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const rows = q.data?.schedules ?? [];
  const chosen = rows.find((s) => s.id === selected) ?? null;
  const close = () => {
    w.setError(null);
    setForm(null);
  };
  return (
    <>
      <PageHeader
        title={t("page.schedules")}
        description={t("schedules.description")}
        actions={<Button ref={addButton} variant="primary" disabled={!w.ready} onClick={() => { opener.current = addButton.current; setForm({ schedule: null }); }}>{t("schedules.new")}</Button>}
      />
      {form !== null && (
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
        <div className="space-y-3">
          {form === null && w.error !== null && <Notice tone="bad">{w.error}</Notice>}
          {q.isError ? <ErrorNote error={q.error} /> : !q.data ? <Loading rows={3} label="loading.schedules" onRetry={() => void q.refetch()} /> : (
            <ScheduleRows rows={rows} selected={selected} onSelect={setSelected} onEdit={(s, el) => { opener.current = el; w.setError(null); setForm({ schedule: s }); }} w={w} />
          )}
        </div>
      </Card>
      <Card title={chosen === null ? t("schedules.runs.label") : t("schedules.runsTitle", { title: chosen.title })}>
        {chosen === null ? <p className="text-sm text-text-2">{t("schedules.runsPick")}</p> : <RunsTable key={chosen.id} id={chosen.id} />}
      </Card>
    </>
  );
}
