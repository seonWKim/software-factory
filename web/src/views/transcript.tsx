import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { API, type StepFilter, type TranscriptPage, type TranscriptStep, getJson } from "../api.js";
import { Button } from "../components/ui/button.js";
import { ButtonRow } from "../components/ui/button-row.js";
import { Badge, Empty, ErrorNote, Loading, Section } from "../components/ui/parts.js";
import { LINK_CLASS } from "../components/ui/link-style.js";
import { cn } from "../lib/cn.js";
import type { MessageKey } from "../i18n/en.js";
import { t } from "../i18n/index.js";
import { ago } from "../lib/format.js";
import { Link } from "../nav.js";
import { BASE, itemPath } from "../pages.js";

// A run's stored transcript (design §9, issue #303), under /app/items/<id>/runs/<run>. The outcome first, then the
// steps, one page (at most 64 KiB of the file) at a time. Every text is what the API gave: scanned on channel
// `ui`, a flagged step already "[withheld: <rule>]". Assistant text collapses past five lines, tool results start
// collapsed, errors are highlighted. A failed run can jump to its last 20 steps, read from the file's end. The
// step-type filter runs on the server, so it holds across pages. Never polls: a stored transcript does not change.

/** Lines of assistant text shown before "Show all". */
export const TEXT_LINES = 5;
/** Filtered pages read in a row while they match nothing, before "Load more" asks. */
const AUTO_PAGES = 20;

const FILTERS: readonly { value: StepFilter | null; label: MessageKey }[] = [
  { value: null, label: "transcript.filterAll" },
  { value: "edits", label: "transcript.filterEdits" },
  { value: "commands", label: "transcript.filterCommands" },
  { value: "reads", label: "transcript.filterReads" },
];

export const transcriptPath = (item: string, run: string) => `${itemPath(item)}/runs/${encodeURIComponent(run)}`;

/** The item and run of a transcript path under /app/ (`items/<id>/runs/<run>`), or null. */
export function transcriptRoute(pathname: string): { itemId: string; runId: string } | null {
  const rest = pathname.startsWith(BASE) ? pathname.slice(BASE.length).replace(/\/+$/, "") : "";
  const m = /^items\/([^/]+)\/runs\/([^/]+)$/.exec(rest);
  if (!m) return null;
  try {
    const itemId = decodeURIComponent(m[1]!);
    const runId = decodeURIComponent(m[2]!);
    return itemId && runId ? { itemId, runId } : null;
  } catch {
    return null;
  }
}

const PRE = "font-mono text-xs whitespace-pre-wrap break-words [overflow-wrap:anywhere]";

function Toggle({ open, onClick, children }: { open: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <Button variant="ghost" size="sm" aria-expanded={open} onClick={onClick} className={cn("mt-1", LINK_CLASS)}>
      {children}
    </Button>
  );
}

/** Assistant (or other) text: the first TEXT_LINES lines, with "Show all" past that. */
function LongText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const lines = text.split("\n");
  const long = lines.length > TEXT_LINES;
  return (
    <>
      <p className="text-sm whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{long && !open ? lines.slice(0, TEXT_LINES).join("\n") : text}</p>
      {long && <Toggle open={open} onClick={() => setOpen(!open)}>{open ? t("transcript.showLess") : t("transcript.showAll", { n: lines.length })}</Toggle>}
    </>
  );
}

/** A tool result: collapsed until asked for (an error result too, but its row is highlighted). */
function ToolResult({ step }: { step: TranscriptStep }) {
  const [open, setOpen] = useState(false);
  const lines = step.text.split("\n").length;
  return (
    <>
      <Toggle open={open} onClick={() => setOpen(!open)}>
        {open ? t("transcript.hideResult") : t(lines === 1 ? "transcript.showResultOne" : "transcript.showResult", { n: lines })}
      </Toggle>
      {open && <pre className={cn(PRE, "mt-1 rounded-control bg-bg p-2")}>{step.text}</pre>}
    </>
  );
}

const KIND_LABEL: Record<TranscriptStep["kind"], MessageKey> = {
  text: "transcript.kindText",
  tool_use: "transcript.kindToolUse",
  tool_result: "transcript.kindToolResult",
  result: "transcript.kindResult",
  system: "transcript.kindSystem",
  error: "transcript.kindError",
  plain: "transcript.kindPlain",
  other: "transcript.kindOther",
  oversize: "transcript.kindOversize",
};

export function StepView({ step }: { step: TranscriptStep }) {
  const body = step.withheld ? (
    <p className="text-sm font-medium">{step.text}</p>
  ) : step.kind === "tool_result" ? (
    <ToolResult step={step} />
  ) : step.kind === "tool_use" || step.kind === "plain" || step.kind === "other" ? (
    <pre className={PRE}>{step.text}</pre>
  ) : (
    <LongText text={step.text} />
  );
  return (
    <li
      data-step={step.kind}
      data-error={step.is_error ? "true" : undefined}
      className={cn(
        "min-w-0 rounded-control border px-3 py-2",
        step.is_error ? "border-pill-bad-fg bg-pill-bad-bg text-pill-bad-fg" : "border-border",
      )}
    >
      <p className="mb-1 flex flex-wrap items-center gap-2 text-xs text-text-2">
        <span className="font-medium">{t(KIND_LABEL[step.kind])}</span>
        {step.tool && <Badge>{step.tool}</Badge>}
        {step.is_error && <Badge level="needs_you">{t("transcript.error")}</Badge>}
        {step.truncated && <span>{t("transcript.truncated")}</span>}
      </p>
      {body}
    </li>
  );
}

function Outcome({ run, now }: { run: TranscriptPage["run"]; now: number }) {
  const o = run.outcome;
  const failed = o?.status === "failed";
  return (
    <div
      role="status"
      aria-label={t("transcript.outcome")}
      className={cn(
        "mt-3 rounded-control px-3 py-2 text-sm break-words [overflow-wrap:anywhere]",
        failed ? "bg-pill-bad-bg text-pill-bad-fg" : o ? "bg-pill-ok-bg text-pill-ok-fg" : "bg-surface-2",
      )}
    >
      <p className="font-medium">
        {failed ? t("transcript.failed", { code: o.error_code ?? t("transcript.unknown") }) : o ? t("transcript.succeeded") : t("transcript.noOutcome", { status: run.status })}
      </p>
      {failed && o.detail && <p>{o.detail}</p>}
      {!failed && o?.summary && <p>{o.summary}</p>}
      <p className="mt-1 text-xs opacity-80 tabular-nums">
        {t("transcript.runLine", { kind: run.kind, attempt: run.attempt, worker: run.worker_id ?? "–", started: run.started_at ? `${ago(run.started_at, now)}${t("topbar.ago")}` : "–" })}
        {run.started_at && run.finished_at ? t("transcript.took", { time: ago(run.started_at, Date.parse(run.finished_at)) }) : ""}
      </p>
    </div>
  );
}

function query(o: { offset: number; filter: StepFilter | null; tail: boolean; part: string | null }): URLSearchParams {
  const p = new URLSearchParams();
  if (o.part) p.set("part", o.part);
  if (o.filter) p.set("filter", o.filter);
  if (o.tail) p.set("tail", "1");
  else if (o.offset > 0) p.set("offset", String(o.offset));
  return p;
}

export function TranscriptView({ itemId, runId }: { itemId: string; runId: string }) {
  const [filter, setFilter] = useState<StepFilter | null>(null);
  const [tail, setTail] = useState(false);
  const [part, setPart] = useState<string | null>(null);
  const [now] = useState(() => Date.now());
  const q = useInfiniteQuery({
    queryKey: ["transcript", itemId, runId, part, filter, tail],
    queryFn: ({ pageParam }) => getJson<TranscriptPage>(API.transcript(itemId, runId, query({ offset: pageParam, filter, tail, part }))),
    initialPageParam: 0,
    getNextPageParam: (last: TranscriptPage) => (last.mode === "tail" || last.next === null ? undefined : last.next),
    refetchInterval: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: Infinity,
    // A filter or mode change keeps the current steps on screen until the new first page arrives.
    placeholderData: keepPreviousData,
  });
  const pages = q.data?.pages ?? [];
  const last = pages.at(-1);
  // A filter that matched nothing on this page reads on, a few pages at a time, so the list is not empty for no reason.
  const emptyRun = (() => {
    let n = 0;
    for (let i = pages.length - 1; i >= 0 && pages[i]!.steps.length === 0; i--) n++;
    return n;
  })();
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = q;
  useEffect(() => {
    if (filter && hasNextPage && !isFetchingNextPage && emptyRun > 0 && emptyRun < AUTO_PAGES) void fetchNextPage();
  }, [filter, hasNextPage, isFetchingNextPage, emptyRun, fetchNextPage]);

  if (q.isError) {
    return (
      <>
        <Back itemId={itemId} />
        <ErrorNote error={q.error} />
      </>
    );
  }
  if (!last) return <Loading rows={6} />;
  const first = pages[0]!;
  const run = first.run;
  const steps = pages.flatMap((p) => p.steps);
  return (
    <>
      <Back itemId={itemId} />
      <h2 className="text-balance text-base font-semibold break-words">{t("transcript.title", { kind: run.kind, attempt: run.attempt })}</h2>
      <Outcome run={run} now={now} />
      <ButtonRow className="mt-6" role="group" aria-label={t("transcript.stepType")}>
        {FILTERS.map((f) => (
          <Button key={f.label} aria-pressed={filter === f.value} onClick={() => setFilter(f.value)}>
            {t(f.label)}
          </Button>
        ))}
        {run.status === "failed" && !tail && (
          <Button variant="ghost" onClick={() => setTail(true)} className={cn("ml-auto", LINK_CLASS)}>{t("transcript.jumpTail")}</Button>
        )}
        {tail && (
          <Button variant="ghost" onClick={() => setTail(false)} className={cn("ml-auto", LINK_CLASS)}>{t("transcript.fromStart")}</Button>
        )}
      </ButtonRow>
      {first.parts.length > 1 && (
        <ButtonRow className="mt-2" role="group" aria-label={t("transcript.agentStep")}>
          {first.parts.map((p) => (
            <Button key={p || "main"} aria-pressed={first.part === p} onClick={() => setPart(p)}>
              {p || t("transcript.mainStep")}
            </Button>
          ))}
        </ButtonRow>
      )}
      <Section title={t("transcript.steps")} count={steps.length}>
        {first.format === "plain" && <p className="mb-2 text-xs text-text-2">{t("transcript.plainFormat")}</p>}
        {tail && first.earlier && <p className="mb-2 text-xs text-text-2">{t("transcript.tailNote")}</p>}
        {steps.length === 0 && !hasNextPage ? (
          <Empty>{filter ? t("transcript.noneOfType") : t("transcript.noSteps")}</Empty>
        ) : (
          <ol aria-label={t("transcript.stepsList")} className="min-w-0 space-y-2">
            {steps.map((s) => <StepView key={s.id} step={s} />)}
          </ol>
        )}
        {hasNextPage && (
          <Button disabled={isFetchingNextPage} onClick={() => void fetchNextPage()} className="mt-3">
            {isFetchingNextPage ? t("transcript.loading") : t("transcript.loadMore")}
          </Button>
        )}
      </Section>
    </>
  );
}

function Back({ itemId }: { itemId: string }) {
  return (
    <p className="mb-1 text-sm">
      <Link href={itemPath(itemId)} className={LINK_CLASS}>{t("transcript.back")}</Link>
    </p>
  );
}
