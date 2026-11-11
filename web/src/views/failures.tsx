import { useState } from "react";
import { API, type FailureGroup, type Failures, useApi } from "../api.js";
import { Button } from "../components/ui/button.js";
import { LINK_CLASS } from "../components/ui/link-style.js";
import { Empty, ErrorNote, Loading, Section, Table, Td, Tr } from "../components/ui/parts.js";
import { cn } from "../lib/cn.js";
import { ago } from "../lib/format.js";
import { Link } from "../nav.js";
import { itemPath } from "../pages.js";
import { useNow } from "./common.js";

const WINDOWS = ["24h", "7d"] as const;
type Window = (typeof WINDOWS)[number];
const WINDOW_LABELS: Record<Window, string> = { "24h": "Last 24 hours", "7d": "Last 7 days" };

/** The window a link selected (`/app/failures?window=7d`); 24h otherwise. */
const initialWindow = (): Window => {
  const w = new URLSearchParams(location.search).get("window");
  return WINDOWS.find((x) => x === w) ?? "24h";
};

/** One error code: its count, last seen and items affected; expanded, the runs behind it. */
function Group({ group, now }: { group: FailureGroup; now: number }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-control border border-border" data-testid="failure-group">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2 text-left text-sm"
      >
        <span className="font-mono text-xs font-semibold">{group.code}</span>
        <span className="tabular-nums">{group.count} {group.count === 1 ? "run" : "runs"}</span>
        <span className="tabular-nums text-text-2">{group.items} {group.items === 1 ? "item" : "items"}</span>
        <span className="tabular-nums text-text-2">last seen {ago(group.last_seen, now)} ago</span>
        {group.description && <span className="basis-full text-pretty text-text-2">{group.description}</span>}
      </button>
      {open && (
        <div className="border-t border-border p-2">
          <Table label={`Runs failed with ${group.code}`} head={["Item", "Attempt", "Detail", "Worker", "When"]}>
            {group.runs.map((r) => (
              <Tr key={r.id}>
                <Td><Link href={itemPath(r.work_item_id)} className={LINK_CLASS}>{r.work_item_id}</Link></Td>
                <Td className="tabular-nums">{r.attempt}</Td>
                <Td className="max-w-md text-xs break-words">{r.detail || "–"}</Td>
                <Td className="font-mono text-xs">{r.worker ?? "–"}</Td>
                <Td className="tabular-nums whitespace-nowrap">{ago(r.finished_at, now)} ago</Td>
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
  return (
    <>
      <div role="group" aria-label="Window" className="mb-4 flex gap-2">
        {WINDOWS.map((w) => (
          <Button key={w} variant="outline" aria-pressed={w === win} className={cn("size-auto px-3 py-1.5", w === win && "bg-surface-2")} onClick={() => setWin(w)}>
            {WINDOW_LABELS[w]}
          </Button>
        ))}
      </div>
      <Section title="Failed runs by error code" count={q.data?.total}>
        {q.isError ? <ErrorNote error={q.error} /> : !q.data ? <Loading rows={3} /> : q.data.groups.length === 0 ? (
          <Empty>No run failed in this window.</Empty>
        ) : (
          <>
            {q.data.capped && (
              <p data-testid="failures-cap" className="mb-2 text-sm text-pretty">
                Showing the newest {q.data.cap} of {q.data.total} failed runs in this window.
              </p>
            )}
            <ul aria-label="Failure groups" className="space-y-2">
              {q.data.groups.map((g) => <Group key={g.code} group={g} now={now} />)}
            </ul>
          </>
        )}
      </Section>
    </>
  );
}
