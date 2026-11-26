import { useState, type ReactNode } from "react";
import { Button } from "../../components/ui/button.js";
import { Disclosure } from "../../components/ui/disclosure.js";
import { KeyValue, ValueBlock } from "../../components/ui/key-value.js";
import { t } from "../../i18n/index.js";
import { cn } from "../../lib/cn.js";
import { type MessageKey } from "../../i18n/en.js";
import { ItemTitle } from "../item-links.js";

// A schedule run's Output cell (design 09-dashboard-schedules): the text the action recorded, for people. A feedback
// run's `{ filed, unfiled }` (src/controller/units/schedule/plugins/feedback/feedback-action.ts) reads as "Filed 2
// items" over the filed titles, each linked to its item page, and the unfiled ones with their reason; any other JSON as
// its summary text or key: value lines; plain text as written. JSON keeps the stored text behind a "Raw output"
// Disclosure. A list longer than SHOWN entries opens the rest in place with "Show N more".

/** One entry: its title, then its note (Already filed, Not filed: why) on the same line, or at the start of the next. */
const ENTRY = "flex min-w-0 flex-wrap items-baseline gap-x-2";

/** Entries a list shows before "Show N more". */
const SHOWN = 3;

type Filed = { id: string; title: string; created: boolean };
type Unfiled = { title: string; reason?: string };
type FeedbackResult = { filed: Filed[]; unfiled: Unfiled[] };

const REASON_TEXT: Record<string, MessageKey> = {
  over_cap: "schedules.output.reason.overCap",
  no_evidence: "schedules.output.reason.noEvidence",
  no_title: "schedules.output.reason.noTitle",
  withheld: "schedules.output.reason.withheld",
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The stored output as JSON when it is an object or array, else null (plain text). */
function parseJson(output: string): unknown {
  const s = output.trim();
  if (!s.startsWith("{") && !s.startsWith("[")) return null;
  try {
    const v: unknown = JSON.parse(s);
    return typeof v === "object" && v !== null ? v : null;
  } catch {
    return null;
  }
}

/** A feedback run's result, when `v` has its shape. */
function feedbackResult(v: unknown): FeedbackResult | null {
  if (!isObject(v) || !Array.isArray(v.filed) || !Array.isArray(v.unfiled)) return null;
  const filed = v.filed.filter((f): f is Filed => isObject(f) && typeof f.id === "string" && typeof f.title === "string");
  const unfiled = v.unfiled.filter(isObject).map((u) => ({ title: typeof u.title === "string" ? u.title : "", ...(typeof u.reason === "string" ? { reason: u.reason } : {}) }));
  return { filed: filed.map((f) => ({ id: f.id, title: f.title, created: f.created !== false })), unfiled };
}

/** Shows the first SHOWN of `items` and opens the rest in place with "Show N more". */
function Collapsed<T>({ items, children }: { items: readonly T[]; children: (shown: readonly T[]) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const hidden = items.length - SHOWN;
  return (
    <div className="flex min-w-0 flex-col items-start">
      {children(open ? items : items.slice(0, SHOWN))}
      {hidden > 0 && (
        <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen(!open)} flush>
          {open ? t("clamp.less") : t("schedules.output.showMore", { n: hidden })}
        </Button>
      )}
    </div>
  );
}

function FeedbackOutput({ result }: { result: FeedbackResult }) {
  const n = result.filed.length;
  const head = n === 0 ? t("schedules.output.nothingFiled") : n === 1 ? t("schedules.output.filedOne") : t("schedules.output.filed", { n });
  const entries = [
    ...result.filed.map((f) => ({
      key: `f:${f.id}`,
      node: (
        <span className={ENTRY}>
          <ItemTitle id={f.id} title={f.title === "" ? null : f.title} />
          {!f.created && <span className="text-xs text-text-2">{t("schedules.output.alreadyFiled")}</span>}
        </span>
      ),
    })),
    ...result.unfiled.map((u, i) => {
      const reason = u.reason !== undefined ? REASON_TEXT[u.reason] : undefined;
      return {
        key: `u:${i}`,
        node: (
          <span className={cn(ENTRY, "text-text-2")}>
            {u.title === "" ? <span>{t("schedules.output.untitled")}</span> : <span data-raw>{u.title}</span>}
            <span className="text-xs">{reason !== undefined ? t("schedules.output.notFiledWhy", { reason: t(reason) }) : t("schedules.output.notFiled")}</span>
          </span>
        ),
      };
    }),
  ];
  return (
    <div data-output="filed" className="min-w-0 space-y-1">
      <p className="font-medium">{head}</p>
      {entries.length > 0 && (
        <Collapsed items={entries}>
          {(shown) => (
            <ul className="w-full min-w-0 space-y-1">
              {shown.map((e) => (
                <li key={e.key} className="min-w-0">{e.node}</li>
              ))}
            </ul>
          )}
        </Collapsed>
      )}
    </div>
  );
}

/** A value of another JSON output in a few words: text and numbers as they are, a list or a group by its size. */
function valueText(v: unknown): string {
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  if (v === null) return t("schedules.output.empty");
  if (Array.isArray(v)) return v.length === 1 ? t("schedules.output.entriesOne") : t("schedules.output.entries", { n: v.length });
  return t("schedules.output.group");
}

/** Any other JSON: its summary text when it has one, else one line per key. */
function OtherOutput({ value }: { value: unknown }) {
  const summary = isObject(value) ? ["summary", "text", "message"].map((k) => value[k]).find((s): s is string => typeof s === "string" && s.trim() !== "") : undefined;
  if (summary !== undefined) return <p data-raw className="whitespace-pre-wrap">{summary}</p>;
  const pairs = isObject(value) ? Object.entries(value) : (value as unknown[]).map((v, i) => [String(i + 1), v] as const);
  if (pairs.length === 0) return <p>{t("schedules.output.empty")}</p>;
  return (
    <Collapsed items={pairs}>
      {(shown) => <KeyValue data-raw items={shown.map(([k, v]) => ({ key: k, term: k, value: valueText(v) }))} className="w-full" />}
    </Collapsed>
  );
}

/** A run's output as people read it; nothing for a run that recorded none. */
export function RunOutput({ output }: { output: string | undefined }) {
  if (output === undefined || output === "") return null;
  const json = parseJson(output);
  if (json === null) return <span data-raw className="whitespace-pre-wrap">{output}</span>;
  const result = feedbackResult(json);
  return (
    <div className="min-w-0 space-y-1">
      {result !== null ? <FeedbackOutput result={result} /> : <OtherOutput value={json} />}
      <Disclosure summary={t("schedules.output.raw")} lazy data-output-raw>
        <ValueBlock>
          <span data-raw>{JSON.stringify(json, null, 2)}</span>
        </ValueBlock>
      </Disclosure>
    </div>
  );
}
