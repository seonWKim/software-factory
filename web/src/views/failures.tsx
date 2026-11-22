import { useMemo, useState } from "react";
import { useUrlParam } from "../lib/url-param.js";
import { type MessageKey, en } from "../i18n/en.js";
import { API, type FailureGroup, type FailureRun, type Failures, type Items, useApi } from "../api.js";
import { Button } from "../components/ui/button.js";
import { type Column, DataTable } from "../components/ui/data-table.js";
import { LINK_CLASS } from "../components/ui/link-style.js";
import { SegmentedControl } from "../components/ui/segmented-control.js";
import { ErrorNote, Loading } from "../components/ui/parts.js";
import { t } from "../i18n/index.js";
import { Link } from "../nav.js";
import { BASE, itemPath } from "../pages.js";
import { RawDetails, When, WorkerName, useNow } from "./common.js";
import { Card, CardSection } from "../components/ui/card.js";
import { EmptyState } from "../components/ui/notice.js";
import { AddModelCredential } from "./model-credential-dialog.js";

const WINDOWS = ["24h", "7d"] as const;
export type FailuresWindow = (typeof WINDOWS)[number];
const WINDOW_LABELS = { "24h": "failures.window24h", "7d": "failures.window7d" } as const satisfies Record<FailuresWindow, MessageKey>;

/**
 * The Failures window, kept in the `window` query parameter so a link (`/app/health?tab=failures&window=7d`) selects it; 24h
 * otherwise. Health holds it and passes it to its toolbar's switch and to FailuresSection.
 */
export function useFailuresWindow(): [FailuresWindow, (w: FailuresWindow) => void] {
  const [w, setW] = useUrlParam("window", (v) => WINDOWS.some((x) => x === v));
  return [WINDOWS.find((x) => x === w) ?? "24h", setW];
}

/** The 24 hours / 7 days switch of the Failures window: a page control, so Health renders it in its PageToolbar. */
export function FailuresWindowSwitch({ value, onChange }: { value: FailuresWindow; onChange: (w: FailuresWindow) => void }) {
  return (
    <div data-failures-window className="flex min-w-0 items-center gap-2">
      <span className="text-xs text-text-2">{t("page.failures")}</span>
      <SegmentedControl label={t("failures.window")} options={WINDOWS.map((w) => ({ id: w, label: t(WINDOW_LABELS[w]) }))} value={value} onChange={onChange} />
    </div>
  );
}

/** The plain copy of one error code: title, meaning and next step; a code with none shows itself and a generic line. */
function copyOf(code: string): { title: string; meaning: string; next: string } {
  const key = (part: string) => `failure.${code}.${part}` as MessageKey;
  return key("title") in en
    ? { title: t(key("title")), meaning: t(key("meaning")), next: t(key("next")) }
    : { title: code, meaning: t("failures.unknownMeaning"), next: t("failures.unknownNext") };
}

/** A run that found no model credential (design 05-restart-pauses): its group opens the Add model credential dialog. */
const SETUP_MISSING = "setup_missing";

/** The Work page narrowed to the items a group hit. */
const workPath = (group: FailureGroup): string => `${BASE}items?ids=${[...new Set(group.runs.map((r) => r.work_item_id))].map(encodeURIComponent).join(",")}`;

/** Each work item's title by ID, from the items list, for the runs a failure group names; an item it lacks keeps its ID. */
export function useItemTitles(): ReadonlyMap<string, string> {
  const items = useApi<Items>(API.items);
  return useMemo(() => new Map((items.data?.items ?? []).flatMap((i) => (i.title ? [[i.id, i.title] as const] : []))), [items.data]);
}

/**
 * One error code as a list item: plain title, meaning and next step, its count, last seen and items affected; expanded,
 * the runs behind it. Health's Failures section and an alarm's Show failures dialog (alarm-dialogs.tsx) draw it.
 */
export function FailureGroupView({ group, now, titles }: { group: FailureGroup; now: number; titles: ReadonlyMap<string, string> }) {
  const [open, setOpen] = useState(false);
  const copy = copyOf(group.code);
  const columns: Column<FailureRun>[] = [
    { key: "item", header: t("col.item"), render: (r) => <Link href={itemPath(r.work_item_id)} data-raw className={LINK_CLASS}>{titles.get(r.work_item_id) ?? r.work_item_id}</Link> },
    { key: "attempt", header: t("col.attempt"), numeric: false, className: "tabular-nums" },
    { key: "detail", header: t("col.detail"), className: "max-w-md text-xs break-words", render: (r) => (r.detail ? <span data-raw>{r.detail}</span> : "–") },
    { key: "worker", header: t("col.worker"), render: (r) => <WorkerName id={r.worker} /> },
    { key: "when", header: t("col.when"), className: "tabular-nums whitespace-nowrap", render: (r) => <When at={r.finished_at} now={now} /> },
  ];
  return (
    <li className="rounded-control border border-border" data-testid="failure-group">
      {/* The toggle is the title alone, on one line (a button is 28 or 32px tall); the counts and copy sit under it. */}
      <Button variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)} className="w-full text-left">
        <span data-raw={copy.title === group.code ? "" : undefined} title={copy.title} className="min-w-0 truncate font-semibold">{copy.title}</span>
      </Button>
      <div className="flex flex-wrap gap-x-3 gap-y-1 px-3 pb-2 text-sm">
        <span className="tabular-nums">{t(group.count === 1 ? "failures.runOne" : "failures.runMany", { count: group.count })}</span>
        <span className="tabular-nums text-text-2">{t(group.items === 1 ? "failures.itemOne" : "failures.itemMany", { count: group.items })}</span>
        <span className="tabular-nums text-text-2"><When at={group.last_seen} now={now} label="failures.lastSeen" /></span>
        <span className="basis-full text-pretty text-text-2">{copy.meaning}</span>
        <span className="basis-full text-pretty">{copy.next}</span>
      </div>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 pb-2 text-sm">
        <Link href={workPath(group)} className={LINK_CLASS}>{t("failures.viewItems")}</Link>
        {group.code === SETUP_MISSING && <AddModelCredential />}
      </p>
      {copy.title !== group.code && (
        <RawDetails className="px-3 pb-2"><span className="font-mono text-xs" data-testid="failure-code">{group.code}</span></RawDetails>
      )}
      {open && (
        <div className="border-t border-border p-2">
          <DataTable label={t("failures.runsFailed", { code: group.code })} columns={columns} rows={group.runs} rowKey={(r) => r.id} empty={t("failures.empty")} />
        </div>
      )}
    </li>
  );
}

/**
 * Health's Failures section: failed runs grouped by error code, for the last 24 hours or 7 days (design §9, issue #312).
 * Health's Failures tab. `win` comes from Health's toolbar switch; without it the section reads the link's window.
 */
export function FailuresSection({ win }: { win?: FailuresWindow }) {
  const now = useNow();
  const [linked] = useFailuresWindow();
  const q = useApi<Failures>(API.failures(win ?? linked));
  const titles = useItemTitles();
  return (
    <Card id="failures" title={t("page.failures")}>
      <CardSection title={t("failures.title")} count={q.data?.total}>
        {q.isError ? <ErrorNote error={q.error} /> : !q.data ? <Loading rows={3} /> : q.data.groups.length === 0 ? (
          <EmptyState title={t("failures.empty")} />
        ) : (
          <>
            {q.data.capped && (
              <p data-testid="failures-cap" className="mb-2 text-sm text-pretty">
                {t("failures.capped", { cap: q.data.cap, total: q.data.total })}
              </p>
            )}
            <ul aria-label={t("failures.groups")} className="space-y-2">
              {q.data.groups.map((g) => <FailureGroupView key={g.code} group={g} now={now} titles={titles} />)}
            </ul>
          </>
        )}
      </CardSection>
    </Card>
  );
}
