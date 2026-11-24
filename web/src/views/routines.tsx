import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { API, type RoutineFields, type RoutineRow, type RoutineVerb, type Session, postRoutine, useApi, useRoutines } from "../api.js";
import { Button } from "../components/ui/button.js";
import { Card } from "../components/ui/card.js";
import { type Column, DataTable } from "../components/ui/data-table.js";
import { OverflowMenu } from "../components/ui/menu.js";
import { Notice, PageHeader } from "../components/ui/notice.js";
import { ErrorNote, Loading } from "../components/ui/parts.js";
import { Switch } from "../components/ui/switch.js";
import { t } from "../i18n/index.js";
import { DeleteRoutineDialog, RoutineDialog, newRoutineId } from "./routines/form.js";
import { repeatsText } from "./routines/labels.js";

// The Routines page (design 09-dashboard-routines, over 08-routines): every routine in a DataTable inside a Card, read
// through GET /api/v1/routines. Each row's Switch is on while the routine is not paused and posts pause or resume; its
// "⋯" menu holds Run now, Edit and Delete. Pressing a row's name (DataTable's `select`) marks the row as current and
// shows its details in a second Card, with a warn Notice while it is paused; with no routine there is no second Card, only the table's empty state. The Cards follow
// the PageHeader as siblings, spaced by the Card's own top margin as on the other pages (no flex gap on top of it). New routine and Edit open one Dialog; Delete asks in a Dialog before it posts. A refusal
// shows in a Notice above the table.

const when = (at: string) => new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const usd = (n: number | null) => (n === null ? t("routines.none") : `$${n}`);

/** The writes the page sends, with the one error they share and a reread after each. */
function useRoutineWrites() {
  const client = useQueryClient();
  const token = useApi<Session>(API.session, false).data?.csrf_token ?? null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const write = async (verb: RoutineVerb, id: string, fields?: RoutineFields): Promise<boolean> => {
    if (token === null || busy) return false;
    setBusy(true);
    setError(null);
    try {
      const r = await postRoutine(token, verb, id, fields);
      if (!r.ok) {
        setError(r.error);
        return false;
      }
      await client.invalidateQueries({ predicate: (q) => typeof q.queryKey[0] === "string" && q.queryKey[0].startsWith(API.routines) });
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

type Writes = ReturnType<typeof useRoutineWrites>;
type Opener = HTMLElement | null;

function RoutineRows({ rows, selected, onSelect, onEdit, onDelete, w }: { rows: readonly RoutineRow[]; selected: string | null; onSelect: (id: string) => void; onEdit: (r: RoutineRow, opener: Opener) => void; onDelete: (r: RoutineRow, opener: Opener) => void; w: Writes }) {
  const columns: Column<RoutineRow>[] = [
    // The name takes the room the other columns leave and is cut to one line (its details Card has it whole); Repeats
    // and Next run stay on one line. `max-w-0` with `w-full` is what lets a table cell shrink below its text.
    { key: "name", header: t("routines.col.name"), className: "w-full max-w-0" },
    { key: "repeats", header: t("routines.col.repeats"), render: (r) => repeatsText(r.schedule), className: "whitespace-nowrap" },
    // Never empty: below `sm` each row is a card whose labels show even for an empty cell.
    { key: "next", header: t("routines.col.next"), render: (r) => (r.paused ? t("routines.nextPaused") : r.next_due_at === null ? t("routines.nextOnMerge") : when(r.next_due_at)), className: "whitespace-nowrap" },
    {
      key: "active",
      header: t("routines.col.active"),
      render: (r) => <Switch checked={!r.paused} disabled={!w.ready || w.busy} aria-label={t("routines.switch", { name: r.name })} onCheckedChange={(on) => void w.write(on ? "resume" : "pause", r.id)} />,
    },
    {
      key: "more",
      header: t("routines.col.more"),
      render: (r) => (
        <OverflowMenu
          label={t("routines.more", { name: r.name })}
          items={[
            { label: t("routines.run"), action: "routine run", disabled: !w.ready || r.paused || r.schedule === null, onSelect: () => void w.write("run", r.id) },
            { label: t("routines.edit"), action: "routine edit", disabled: !w.ready, onSelect: () => onEdit(r, document.activeElement as Opener) },
            { label: t("routines.delete"), action: "routine delete", disabled: !w.ready, onSelect: () => onDelete(r, document.activeElement as Opener) },
          ]}
        />
      ),
    },
  ];
  return <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} label={t("routines.listLabel")} empty={t("routines.empty")} dataKey select={{ key: selected, onSelect, label: (r) => t("routines.select", { name: r.name }) }} />;
}

function Detail({ r }: { r: RoutineRow }) {
  const rows: [string, string][] = [
    [t("routines.detail.instruction"), r.instruction],
    [t("routines.detail.url"), r.url ?? t("routines.none")],
    [t("routines.detail.zone"), r.zone],
    [t("routines.detail.last"), r.last_run_at === null ? t("routines.never") : when(r.last_run_at)],
    [t("routines.detail.runCap"), usd(r.run_cap_usd)],
    [t("routines.detail.dailyCap"), usd(r.daily_cap_usd)],
  ];
  return (
    <div className="space-y-3">
      {r.paused && <Notice tone="warn">{t("routines.paused")}</Notice>}
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-text-2">{k}</dt>
            <dd className="break-words whitespace-pre-wrap">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

type FormState = { kind: "edit"; routine: RoutineRow | null } | { kind: "delete"; routine: RoutineRow };

export function RoutinesPage() {
  const q = useRoutines();
  const w = useRoutineWrites();
  const [selected, setSelected] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const opener = useRef<Opener>(null);
  const rows = q.data?.routines ?? [];
  const chosen = rows.find((r) => r.id === selected) ?? null;
  const close = () => {
    w.setError(null);
    setForm(null);
  };
  const open = (f: FormState, el: Opener) => {
    opener.current = el;
    w.setError(null);
    setForm(f);
  };
  return (
    <>
      <PageHeader
        title={t("page.routines")}
        description={t("routines.description")}
        actions={<Button ref={addButton} variant="primary" data-capture-open="new-routine" disabled={!w.ready} onClick={() => open({ kind: "edit", routine: null }, addButton.current)}>{t("routines.new")}</Button>}
      />
      {form?.kind === "edit" && (
        <RoutineDialog
          routine={form.routine}
          busy={w.busy}
          error={w.error}
          returnFocusTo={opener}
          onSave={(fields) => (form.routine === null ? w.write("add", newRoutineId(fields.name ?? "", rows.map((r) => r.id)), fields) : w.write("edit", form.routine.id, fields))}
          onClose={close}
        />
      )}
      {form?.kind === "delete" && (
        <DeleteRoutineDialog
          routine={form.routine}
          busy={w.busy}
          error={w.error}
          returnFocusTo={opener}
          onConfirm={() => void w.write("delete", form.routine.id).then((ok) => {
            if (!ok) return;
            if (selected === form.routine.id) setSelected(null);
            close();
          })}
          onClose={close}
        />
      )}
      <Card label={t("routines.listLabel")}>
        <div className="space-y-3">
          {form === null && w.error !== null && <Notice tone="bad">{w.error}</Notice>}
          {q.isError ? <ErrorNote error={q.error} /> : !q.data ? <Loading rows={3} label="loading.routines" onRetry={() => void q.refetch()} /> : (
            <RoutineRows rows={rows} selected={selected} onSelect={setSelected} onEdit={(r, el) => open({ kind: "edit", routine: r }, el)} onDelete={(r, el) => open({ kind: "delete", routine: r }, el)} w={w} />
          )}
        </div>
      </Card>
      {rows.length > 0 && (
        <Card title={chosen === null ? t("routines.col.name") : chosen.name}>
          {chosen === null ? <p className="text-sm text-text-2">{t("routines.detailPick")}</p> : <Detail r={chosen} />}
        </Card>
      )}
    </>
  );
}
