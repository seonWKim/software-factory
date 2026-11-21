import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { API, type ImproveGroupView, type ImproveView, postImproveRun } from "../api.js";
import { Button } from "../components/ui/button.js";
import { Card } from "../components/ui/card.js";
import { Disclosure } from "../components/ui/disclosure.js";
import { KeyValue } from "../components/ui/key-value.js";
import { ListRow, ROW_TITLE } from "../components/ui/list-row.js";
import type { MessageKey } from "../i18n/en.js";
import { Notice } from "../components/ui/notice.js";
import { t } from "../i18n/index.js";
import { localDateTime } from "../lib/format.js";
import { ROW_PAD, STACK_NARROW, line, muted } from "./rules-shared.js";

// The improve report, the Health page's Improve tab (design 07-self-improvement, 2026-11-16; moved off the Rules page
// 2026-11-21), from GET /api/v1/rules's `improve`: its window and counts, then one row per failure group titled in
// plain words (a label per known error code, else "Other failure"; never the code or a file path), with its runs and
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
        <span className={muted}>{t("rules.runNowHint")}</span>
      </div>
      {result !== null && <Notice tone={result.ok ? "ok" : "bad"}>{result.text}</Notice>}
    </div>
  );
}

/** The plain title of each known error code; any other code reads "Other failure". */
const CODE_TITLE: Record<string, MessageKey> = {
  hotspot: "rules.code.hotspot",
  pushback: "rules.code.pushback",
  checks_failed: "rules.code.checksFailed",
  checks_env: "rules.code.checksFailed",
  tests_failed: "rules.code.testsFailed",
  flaky_test: "rules.code.flakyTest",
  spec_conflict: "rules.code.specConflict",
  agent_stalled: "rules.code.agentStalled",
  agent_timed_out: "rules.code.agentTimedOut",
  start_to_close: "rules.code.agentTimedOut",
  schedule_to_close: "rules.code.agentTimedOut",
  agent_failed: "rules.code.agentFailed",
  exception: "rules.code.exception",
  no_commits: "rules.code.noCommits",
  scope_violation: "rules.code.outOfScope",
  out_of_scope: "rules.code.outOfScope",
  push_failed: "rules.code.pushFailed",
  git_failed: "rules.code.pushFailed",
  merge_conflict: "rules.code.mergeConflict",
  session_lost: "rules.code.sessionLost",
  not_resumable: "rules.code.sessionLost",
  abandoned: "rules.code.sessionLost",
  warm_failed: "rules.code.warmFailed",
  diff_too_large: "rules.code.diffTooLarge",
  rate_limited: "rules.code.rateLimited",
  invalid_output: "rules.code.invalidOutput",
  forge_auth: "rules.code.forgeAuth",
  egress_blocked: "rules.code.egressBlocked",
};

/** A failure group's one-line title in plain words. */
export const groupTitle = (code: string): string => t(CODE_TITLE[code] ?? "rules.code.other");

/** One failure group: its plain title, runs and filing, then its detail, draft and code behind a Disclosure. */
function ImproveGroup({ g }: { g: ImproveGroupView }) {
  const title = groupTitle(g.error_code);
  return (
    <ListRow
      data-improve-group={g.error_code}
      className={ROW_PAD}
      title={<p data-group-title className={`${ROW_TITLE} font-medium`} title={title}>{title}</p>}
      details={
        <>
          <span className="tabular-nums">{t("rules.improveRuns", { count: g.runs })}</span>
          <span data-filing className="min-w-0 break-keep">{g.filing ?? t("rules.improveNotFiled")}</span>
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
                    {g.draft?.note != null && <p className={line}>{g.draft.note}</p>}
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
