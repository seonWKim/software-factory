import { useMemo, useState } from "react";
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

const WINDOWS = ["24h", "7d"] as const;
type Window = (typeof WINDOWS)[number];
const WINDOW_LABELS = { "24h": "failures.window24h", "7d": "failures.window7d" } as const satisfies Record<Window, MessageKey>;

/** The window a link selected (`/app/failures?window=7d`); 24h otherwise. */
const initialWindow = (): Window => {
  const w = new URLSearchParams(location.search).get("window");
  return WINDOWS.find((x) => x === w) ?? "24h";
};

/** The plain copy of one error code: title, meaning and next step; a code with none shows itself and a generic line. */
function copyOf(code: string): { title: string; meaning: string; next: string } {
  const key = (part: string) => `failure.${code}.${part}` as MessageKey;
  return key("title") in en
    ? { title: t(key("title")), meaning: t(key("meaning")), next: t(key("next")) }
    : { title: code, meaning: t("failures.unknownMeaning"), next: t("failures.unknownNext") };
}

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
    { key: "item", header: t("col.item"), render: (r) => <Link href={itemPath(r.work_item_id)} className={LINK_CLASS}>{titles.get(r.work_item_id) ?? r.work_item_id}</Link> },
    { key: "attempt", header: t("col.attempt"), numeric: false, className: "tabular-nums" },
    { key: "detail", header: t("col.detail"), className: "max-w-md text-xs break-words", render: (r) => r.detail || "–" },
    { key: "worker", header: t("col.worker"), render: (r) => <WorkerName id={r.worker} /> },
    { key: "when", header: t("col.when"), className: "tabular-nums whitespace-nowrap", render: (r) => <When at={r.finished_at} now={now} /> },
  ];
  return (
    <li className="rounded-control border border-border" data-testid="failure-group">
      <Button
        variant="ghost"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="w-full flex-wrap gap-x-3 gap-y-1 py-2 text-left"
      >
        <span className="font-semibold">{copy.title}</span>
        <span className="tabular-nums">{t(group.count === 1 ? "failures.runOne" : "failures.runMany", { count: group.count })}</span>
        <span className="tabular-nums text-text-2">{t(group.items === 1 ? "failures.itemOne" : "failures.itemMany", { count: group.items })}</span>
        <span className="tabular-nums text-text-2"><When at={group.last_seen} now={now} label="failures.lastSeen" /></span>
        <span className="basis-full text-pretty text-text-2">{copy.meaning}</span>
        <span className="basis-full text-pretty">{copy.next}</span>
      </Button>
      <p className="px-3 pb-2 text-sm">
        <Link href={workPath(group)} className={LINK_CLASS}>{t("failures.viewItems")}</Link>
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

/** Health's Failures section: failed runs grouped by error code, for the last 24 hours or 7 days (design §9, issue #312). Its anchor is `#failures`. */
export function FailuresSection() {
  const now = useNow();
  const [win, setWin] = useState<Window>(initialWindow);
  const q = useApi<Failures>(API.failures(win));
  const titles = useItemTitles();
  return (
    <Card id="failures" title={t("page.failures")}>
      <SegmentedControl label={t("failures.window")} options={WINDOWS.map((w) => ({ id: w, label: t(WINDOW_LABELS[w]) }))} value={win} onChange={setWin} className="mb-6" />
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
