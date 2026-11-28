import type { ItemCheck } from "../api.js";
import { Badge } from "../components/ui/badge.js";
import { Disclosure } from "../components/ui/disclosure.js";
import type { MessageKey } from "../i18n/en.js";
import { t } from "../i18n/index.js";

// The About card's done-when checks (docs/design/09-dashboard-item.md): each line with its check in plain words and
// its latest result as a Badge before the line; a failed line's output tail sits behind a closed Disclosure. A withheld text shows the
// withheld note, never the marker.

/** Each result's Badge: its level (the one status colour map) and its label. */
const RESULT: Record<ItemCheck["result"], { level?: string; label: MessageKey }> = {
  pass: { level: "ready_to_merge", label: "item.checkPass" },
  fail: { level: "needs_you", label: "item.checkFail" },
  manual: { level: "running", label: "item.checkManual" },
  not_run: { label: "item.checkNotRun" },
};

/** How each kind of check reads. */
const HOW: Record<ItemCheck["check"]["kind"], MessageKey> = { command: "item.checkCommand", test: "item.checkTest", manual: "item.checkPerson" };

const withheld = (v: string) => v.startsWith("[withheld: ");
const shown = (v: string) => (withheld(v) ? t("item.aboutWithheld") : v);

/** One done-when line: the line, how it is checked, the result, and a failed line's output. */
function CheckRow({ row }: { row: ItemCheck }) {
  const r = RESULT[row.result] ?? RESULT.not_run;
  const tail = row.result === "fail" && row.output_tail !== null && !withheld(row.output_tail) ? row.output_tail : null;
  return (
    <li data-check={row.result} className="flex min-w-0 items-start gap-3 py-2 first:pt-0 last:pb-0">
      <span data-check-badge className="shrink-0"><Badge level={r.level}>{t(r.label)}</Badge></span>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-pretty break-words">{shown(row.line)}</p>
        <p className="mt-0.5 text-xs text-pretty text-text-2 wrap-anywhere">{t(HOW[row.check.kind], { check: shown(row.check.text) })}</p>
        {tail !== null && (
          <Disclosure data-check-output className="mt-1" summary={t("item.checkOutput")}>
            <pre className="mt-1 max-h-64 overflow-auto rounded-control bg-surface-2 p-2 font-mono text-xs whitespace-pre-wrap wrap-anywhere">{tail}</pre>
          </Disclosure>
        )}
      </div>
    </li>
  );
}

/** The done-when lines with their checks and results, in order; nothing for an empty list. */
export function ItemChecks({ checks }: { checks: readonly ItemCheck[] }) {
  if (checks.length === 0) return null;
  return (
    <ul aria-label={t("item.checks")} className="divide-y divide-border">
      {checks.map((row, i) => <CheckRow key={i} row={row} />)}
    </ul>
  );
}
