import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { API, type ImproveGroupView, type ImproveView, postImproveRun } from "../api.js";
import { Button } from "../components/ui/button.js";
import { Card } from "../components/ui/card.js";
import { KeyValue } from "../components/ui/key-value.js";
import { Notice } from "../components/ui/notice.js";
import { t } from "../i18n/index.js";
import { localDateTime } from "../lib/format.js";
import { line, muted } from "./rules-shared.js";

// The Rules page's improve report (design 07-self-improvement, 2026-11-16), from GET /api/v1/rules's `improve`: its
// window and counts, then one row per failure group with its draft and filing. Run now shows only when `run_now` says
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
        <span className={muted}>{t("rules.runNowHint")}</span>
      </div>
      {result !== null && <Notice tone={result.ok ? "ok" : "bad"}>{result.text}</Notice>}
    </div>
  );
}

/** One failure group: its error code and runs, its detail, its draft (cause and fix, or a note) and its filing. */
function ImproveGroup({ g }: { g: ImproveGroupView }) {
  return (
    <li data-improve-group={g.error_code} className="min-w-0 space-y-1 px-3 py-2">
      <p className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-mono text-sm break-all">{g.error_code}</span>
        <span className="text-xs text-text-2 tabular-nums">{t("rules.improveRuns")}: {g.runs}</span>
      </p>
      {g.detail !== null && <p className={`${line} text-text-2`}>{g.detail}</p>}
      <KeyValue
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
                {g.draft?.note != null && <p className={line}>{g.draft.note}</p>}
              </div>
            ),
          },
          { key: "filing", term: <span className="font-semibold">{t("rules.improveFiling")}</span>, valueProps: { "data-filing": true }, value: <span className={g.filing === null ? muted : line}>{g.filing ?? t("rules.improveNotFiled")}</span> },
        ]}
      />
    </li>
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
                {t("rules.improveWindow", {
                  start: localDateTime(r.window_start), end: localDateTime(r.window_end), created: localDateTime(r.created_at), groups: r.groups.length, runs: r.runs, patterns: r.patterns,
                })}
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
