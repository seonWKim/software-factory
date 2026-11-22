import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { API, type ImproveFilingView, type ImproveGroupView, type ImproveNote, type ImproveReportView, type ImproveView, postImproveRun } from "../api.js";
import { Button } from "../components/ui/button.js";
import { Card } from "../components/ui/card.js";
import { Disclosure } from "../components/ui/disclosure.js";
import { KeyValue } from "../components/ui/key-value.js";
import { ListRow, ROW_TITLE } from "../components/ui/list-row.js";
import type { MessageKey } from "../i18n/en.js";
import { Notice } from "../components/ui/notice.js";
import { t } from "../i18n/index.js";
import { isPreviousLocalDay, localShortDate } from "../lib/format.js";
import { ROW_PAD, STACK_NARROW, line, muted } from "./rules-shared.js";

// The improve report, the Health page's Improve tab (design 07-self-improvement, 2026-11-16; moved off the Rules page
// 2026-11-21), from GET /api/v1/rules's `improve`: its window and counts, then one row per failure group titled in
// plain words (its detail, else its draft cause, else "Repeated failure"; a hot file "Often-edited file"), with its runs and
// filing on the details line and its detail, draft and code behind a Disclosure. Run now shows only when `run_now` says
// the viewer may run it (approve_spec); it posts to POST /api/v1/improve/run and shows the queued run_id, or a 409's
// refusal and the run already queued, with no reload.

/**
 * Run now: posts to POST /api/v1/improve/run and shows the queued run_id, or the refusal and the run already queued
 * (409). The rules are reloaded only after a run was queued, so a refusal never reads as one.
 */
function RunNow({ token }: { token: string }) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = await postImproveRun(token);
      if (r.ok) {
        setResult({ ok: true, text: t("rules.runNowQueued", { run_id: r.run_id }) });
        await client.invalidateQueries({ queryKey: [API.rules] });
      } else {
        setResult({ ok: false, text: r.run_id === null ? r.error : t("rules.runNowRefused", { error: r.error, run_id: r.run_id }) });
      }
    } catch (err) {
      setResult({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div data-run-now className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => void run()}>
          {t("rules.runNow")}
        </Button>
      </div>
      {result !== null && <Notice tone={result.ok ? "ok" : "bad"}>{result.text}</Notice>}
    </div>
  );
}

/** The plain phrase of each skip, failed and withheld reason src/core/improver.ts records. */
const REASON_KEYS: Readonly<Record<string, MessageKey>> = {
  issue_cap: "rules.reason.issue_cap",
  comment_cap: "rules.reason.comment_cap",
  recently_closed: "rules.reason.recently_closed",
  no_source: "rules.reason.no_source",
  needs_person: "rules.reason.needs_person",
  host_sleep: "rules.reason.host_sleep",
  pause: "rules.reason.pause",
  in_flight: "rules.reason.in_flight",
  open_item: "rules.reason.open_item",
  call_cap: "rules.reason.call_cap",
  error: "rules.reason.error",
  refused: "rules.reason.refused",
  max_tokens: "rules.reason.max_tokens",
  invalid_output: "rules.reason.invalid_output",
  withheld: "rules.reason.withheld",
};

/** A reason in plain words; null for a code with no phrase (the code is never shown). */
function reasonPhrase(reason: string | null): string | null {
  const key = reason === null ? undefined : REASON_KEYS[reason];
  return key === undefined ? null : t(key);
}

/** A group's one-line title: a hotspot is "Often-edited file", else its detail, else its draft's cause, else "Repeated failure". */
function groupTitle(g: ImproveGroupView): string {
  if (g.hotspot) return t("rules.titleHotspot");
  return g.detail ?? g.draft?.cause ?? t("rules.titleRepeated");
}

/** A group's filing on its details line: where it went, or "not filed" with the plain reason when there is one. */
function filingText(f: ImproveFilingView | null): string {
  if (f === null) return t("rules.improveNotFiled");
  if (f.status === "filed" || f.status === "linked") return t("rules.filedRef", { status: f.status, ref: f.ref ?? "" });
  if (f.status === "commented") return t("rules.commentedRef", { ref: f.ref ?? "", runs: f.runs ?? 0 });
  const why = reasonPhrase(f.reason);
  return why === null ? t("rules.notFiled") : t("rules.notFiledWhy", { why });
}

/** A group's draft note (skipped, failed or withheld) in plain words. */
function noteText(n: ImproveNote): string {
  const why = reasonPhrase(n.reason);
  return why === null ? t("rules.improveNoDraft") : t("rules.noDraftWhy", { why });
}

/** The header: "Yesterday (Nov 18): …" for the previous local day, else "{start} to {end}: …", dates short and local. */
function windowText(r: ImproveReportView): string {
  const counts = { groups: r.groups.length, runs: r.runs };
  if (isPreviousLocalDay(r.window_start, r.window_end, r.created_at)) return t("rules.improveHeaderDay", { date: localShortDate(r.window_start), ...counts });
  return t("rules.improveHeaderRange", { start: localShortDate(r.window_start), end: localShortDate(r.window_end), ...counts });
}

/** One failure group: its plain title, runs and filing, then its detail, draft and code behind a Disclosure. */
function ImproveGroup({ g }: { g: ImproveGroupView }) {
  const title = groupTitle(g);
  return (
    <ListRow
      data-improve-group={g.error_code}
      className={ROW_PAD}
      title={<p data-group-title className={`${ROW_TITLE} font-medium`} title={title}>{title}</p>}
      details={
        <>
          <span className="tabular-nums">{t("rules.improveRuns", { count: g.runs })}</span>
          <span data-filing className="min-w-0 break-keep">{filingText(g.filing)}</span>
        </>
      }
    >
      <Disclosure lazy summary={t("rules.improveShowDraft")}>
        <div className="mt-2 space-y-2">
          {g.detail !== null && <p className={`${line} text-text-2`}>{g.detail}</p>}
          <KeyValue
            className={STACK_NARROW}
            items={[
              {
                key: "draft",
                term: <span className="font-semibold">{t("rules.improveDraft")}</span>,
                valueProps: { "data-draft": true },
                value: (
                  <div className="space-y-0.5">
                    {g.draft === null && <p className={muted}>{t("rules.improveNoDraft")}</p>}
                    {g.draft?.cause != null && <p className={line}>{t("rules.improveCause", { cause: g.draft.cause })}</p>}
                    {g.draft?.fix != null && <p className={line}>{t("rules.improveFix", { fix: g.draft.fix })}</p>}
                    {g.draft?.note != null && <p className={line}>{noteText(g.draft.note)}</p>}
                  </div>
                ),
              },
              { key: "code", term: <span className="font-semibold">{t("rules.improveCode")}</span>, value: <code className="font-mono text-xs break-all">{g.error_code}</code> },
            ]}
          />
        </div>
      </Disclosure>
    </ListRow>
  );
}

/** The latest improve report and, for a viewer who may run one, Run now. */
export function Improve({ view }: { view: ImproveView }) {
  const r = view.report;
  return (
    <div id="improve" data-improve>
      <Card title={t("rules.improveTitle")} count={r?.groups.length}>
        <div className="space-y-2">
          {r === null ? (
            <p className={muted}>{t("rules.improveNone")}</p>
          ) : (
            <>
              <p data-improve-window className={`${muted} tabular-nums`}>
                {windowText(r)}
              </p>
              {r.groups.length === 0 ? (
                <p className={muted}>{t("rules.improveNoGroup")}</p>
              ) : (
                <ul aria-label={t("rules.improveTitle")} className="divide-y divide-border rounded-control border border-border">
                  {r.groups.map((g, i) => <ImproveGroup key={`${g.error_code}${i}`} g={g} />)}
                </ul>
              )}
            </>
          )}
          {view.run_now && view.csrf_token !== null && <RunNow token={view.csrf_token} />}
        </div>
      </Card>
    </div>
  );
}
