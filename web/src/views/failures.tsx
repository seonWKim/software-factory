import { useMemo, useState } from "react";
import { type MessageKey } from "../i18n/en.js";
import { API, type FailureGroup, type Failures, type Items, useApi } from "../api.js";
import { Button } from "../components/ui/button.js";
import { ButtonRow } from "../components/ui/button-row.js";
import { LINK_CLASS } from "../components/ui/link-style.js";
import { Empty, ErrorNote, Loading, Section, Table, Td, Tr } from "../components/ui/parts.js";
import { t } from "../i18n/index.js";
import { ago } from "../lib/format.js";
import { Link } from "../nav.js";
import { itemPath } from "../pages.js";
import { WorkerName, useNow } from "./common.js";

const WINDOWS = ["24h", "7d"] as const;
type Window = (typeof WINDOWS)[number];
const WINDOW_LABELS = { "24h": "failures.window24h", "7d": "failures.window7d" } as const satisfies Record<Window, MessageKey>;

/** The window a link selected (`/app/failures?window=7d`); 24h otherwise. */
const initialWindow = (): Window => {
  const w = new URLSearchParams(location.search).get("window");
  return WINDOWS.find((x) => x === w) ?? "24h";
};

/** One error code: its count, last seen and items affected; expanded, the runs behind it. */
function Group({ group, now, titles }: { group: FailureGroup; now: number; titles: ReadonlyMap<string, string> }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-control border border-border" data-testid="failure-group">
      <Button
        variant="ghost"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="w-full flex-wrap gap-x-3 gap-y-1 py-2 text-left"
      >
        <span className="font-mono text-xs font-semibold">{group.code}</span>
        <span className="tabular-nums">{t(group.count === 1 ? "failures.runOne" : "failures.runMany", { count: group.count })}</span>
        <span className="tabular-nums text-text-2">{t(group.items === 1 ? "failures.itemOne" : "failures.itemMany", { count: group.items })}</span>
        <span className="tabular-nums text-text-2">{t("failures.lastSeen", { time: t("time.ago", { time: ago(group.last_seen, now) }) })}</span>
        {group.description && <span className="basis-full text-pretty text-text-2">{group.description}</span>}
      </Button>
      {open && (
        <div className="border-t border-border p-2">
          <Table label={t("failures.runsFailed", { code: group.code })} head={[t("col.item"), t("col.attempt"), t("col.detail"), t("col.worker"), t("col.when")]}>
            {group.runs.map((r) => (
              <Tr key={r.id}>
                <Td><Link href={itemPath(r.work_item_id)} className={LINK_CLASS}>{titles.get(r.work_item_id) ?? r.work_item_id}</Link></Td>
                <Td className="tabular-nums">{r.attempt}</Td>
                <Td className="max-w-md text-xs break-words">{r.detail || "–"}</Td>
                <Td><WorkerName id={r.worker} /></Td>
                <Td className="tabular-nums whitespace-nowrap">{t("time.ago", { time: ago(r.finished_at, now) })}</Td>
              </Tr>
            ))}
          </Table>
        </div>
      )}
    </li>
  );
}

/** Failed runs grouped by error code, for the last 24 hours or 7 days (design §9, issue #312). */
export function FailuresPage() {
  const now = useNow();
  const [win, setWin] = useState<Window>(initialWindow);
  const q = useApi<Failures>(API.failures(win));
  // Items show by title; an item the list does not hold keeps its ID.
  const items = useApi<Items>(API.items);
  const titles = useMemo(() => new Map((items.data?.items ?? []).flatMap((i) => (i.title ? [[i.id, i.title] as const] : []))), [items.data]);
  return (
    <>
      <ButtonRow role="group" aria-label={t("failures.window")} className="mb-6">
        {WINDOWS.map((w) => (
          <Button key={w} aria-pressed={w === win} onClick={() => setWin(w)}>
            {t(WINDOW_LABELS[w])}
          </Button>
        ))}
      </ButtonRow>
      <Section title={t("failures.title")} count={q.data?.total}>
        {q.isError ? <ErrorNote error={q.error} /> : !q.data ? <Loading rows={3} /> : q.data.groups.length === 0 ? (
          <Empty>{t("failures.empty")}</Empty>
        ) : (
          <>
            {q.data.capped && (
              <p data-testid="failures-cap" className="mb-2 text-sm text-pretty">
                {t("failures.capped", { cap: q.data.cap, total: q.data.total })}
              </p>
            )}
            <ul aria-label={t("failures.groups")} className="space-y-2">
              {q.data.groups.map((g) => <Group key={g.code} group={g} now={now} titles={titles} />)}
            </ul>
          </>
        )}
      </Section>
    </>
  );
}
