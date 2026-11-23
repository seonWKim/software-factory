import { API, type Failures, type SystemAction, useApi } from "../api.js";
import { Dialog } from "../components/ui/dialog.js";
import { ErrorNote, Loading } from "../components/ui/parts.js";
import { t } from "../i18n/index.js";
import { useNow } from "./common.js";
import { FailureGroupView, useItemTitles } from "./failures.js";

// The dialogs an alarm row's "⋯" menu opens on the Tasks page (design 09-dashboard-tasks): What failed for a red main
// check, Show failures for a repeated error. Both are read only and stay on the page; Close (or Cancel) shuts them.

/** What the red-main check printed, as the overview carries it on a red_main alarm and a red_main auto stop; absent: none kept. */
type CheckOutput = Pick<SystemAction, "failing_tests" | "output_tail">;

/**
 * What failed on the base branch: the failing tests one per line, then the output tail in a preformatted block. With no
 * tail kept (an older stop, a tail the egress scan flagged, a cause with no check) it says so, with no empty block.
 */
export function WhatFailedDialog({ output, onClose }: { output: CheckOutput; onClose: () => void }) {
  const tests = output.failing_tests ?? [];
  const tail = output.output_tail ?? null;
  return (
    <Dialog title={t("needs.whatFailed")} confirmLabel={t("needs.alarmClose")} onConfirm={onClose} onClose={onClose}>
      <div data-what-failed className="min-w-0 space-y-2 text-sm">
        {tests.length > 0 && (
          <>
            <p className="font-medium">{t("needs.whatFailedTests")}</p>
            <ul data-failing-tests className="space-y-0.5 font-mono text-xs wrap-anywhere">
              {tests.map((name) => <li key={name}>{name}</li>)}
            </ul>
          </>
        )}
        {tail === null ? (
          <p data-no-output className="text-pretty text-text-2">{t("needs.whatFailedNone")}</p>
        ) : (
          <>
            <p className="font-medium">{t("needs.whatFailedOutput")}</p>
            <pre data-output-tail className="max-h-64 overflow-auto rounded-control bg-surface-2 p-2 font-mono text-xs whitespace-pre-wrap wrap-anywhere">{tail}</pre>
          </>
        )}
      </div>
    </Dialog>
  );
}

/** The failure group of one error code from GET /api/v1/failures (the last 24 hours), drawn as Health's Failures section draws it. */
export function ShowFailuresDialog({ code, onClose }: { code: string; onClose: () => void }) {
  const now = useNow();
  const q = useApi<Failures>(API.failures("24h"));
  const titles = useItemTitles();
  const group = q.data?.groups.find((g) => g.code === code);
  return (
    <Dialog title={t("needs.showFailures")} confirmLabel={t("needs.alarmClose")} onConfirm={onClose} onClose={onClose}>
      <div data-show-failures className="min-w-0 text-sm">
        {q.isError ? <ErrorNote error={q.error} /> : !q.data ? <Loading rows={2} label="loading.failures" onRetry={() => void q.refetch()} /> : group ? (
          <ul>
            <FailureGroupView group={group} now={now} titles={titles} />
          </ul>
        ) : (
          <p className="text-pretty text-text-2">{t("needs.showFailuresNone")}</p>
        )}
      </div>
    </Dialog>
  );
}
