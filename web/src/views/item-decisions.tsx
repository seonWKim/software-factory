import type { SpecDecision, WaitingSpec } from "../api.js";
import { Markdown } from "../components/ui/markdown.js";
import { Section } from "../components/ui/parts.js";
import { cn } from "../lib/cn.js";

// The item page's spec panel (design §9, issue #526): the waiting spec's In short above Commands, and its decisions
// as questions to answer before `approve`. A decision with options is a radio group with the default selected and
// a `write my own` choice with a text field; one with none is a text field prefilled with the default. The answers
// go out with the approve as `N: <answer>` lines (the controller's parser, src/shared/command-notes.ts), and the
// confirm step names what is approved and what happens next.

/** One decision's answer on the page: an option picked, or the text written (`own`). */
export interface DecisionChoice {
  own: boolean;
  value: string;
}

/** The answers the panel starts with: each default selected (an option) or prefilled (a free answer). */
export function initialChoices(decisions: readonly SpecDecision[]): DecisionChoice[] {
  return decisions.map((d) => (d.options.length > 0 && d.default !== null && d.options.includes(d.default)
    ? { own: false, value: d.default }
    : { own: true, value: d.default ?? "" }));
}

/** One decision's answer as the confirm step names it, and whether it is the default. */
export interface ChosenAnswer {
  n: number;
  question: string;
  answer: string | null;
  isDefault: boolean;
}

export function chosenAnswers(decisions: readonly SpecDecision[], choices: readonly DecisionChoice[]): ChosenAnswer[] {
  return decisions.map((d, i) => {
    const answer = choices[i]?.value.trim() || null;
    return { n: i + 1, question: d.question, answer, isDefault: answer !== null && answer === d.default };
  });
}

/** The approve note: one `N: <answer>` line per answered decision, then the free note. */
export function approveNote(answers: readonly ChosenAnswer[], note: string): string {
  return [...answers.filter((a) => a.answer !== null).map((a) => `${a.n}: ${a.answer}`), note.trim()].filter(Boolean).join("\n");
}

/** The approve phases that confirm first, from the item's block. */
export type ApprovePhase = "spec_pending" | "max_revisions" | "floor_tier" | "rule_of_two";

/** The item's approve phase; null for any other state (an implement run held by coordination cost sends at once). */
export function approvePhase(blockedReason: string | null | undefined): ApprovePhase | null {
  return blockedReason === "spec_pending" || blockedReason === "max_revisions" || blockedReason === "floor_tier" || blockedReason === "rule_of_two"
    ? blockedReason
    : null;
}

/** What an approve in `phase` approves, and what happens next. */
const PHASES: Record<ApprovePhase, { what: string; next: string }> = {
  spec_pending: { what: "the spec waiting for approval", next: "The factory starts the implement run on this spec." },
  max_revisions: {
    what: "the spec at the revision limit, as it is (no new revision)",
    next: "The factory starts the implement run on this spec.",
  },
  floor_tier: {
    what: "a tier raise to the tier the floor check needs",
    next: "The item's tier is raised and the implement run starts again.",
  },
  rule_of_two: { what: "the run held for a person by the Rule of Two", next: "The held run starts." },
};

const field =
  "rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900 " +
  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-600";

/** The waiting spec's In short, above Commands. */
export function InShort({ spec }: { spec: WaitingSpec | null | undefined }) {
  if (!spec?.in_short) return null;
  return (
    <Section title="In short">
      <div data-in-short>
        <Markdown text={spec.in_short} />
      </div>
    </Section>
  );
}

/** The decisions as questions, each answered on the page. */
export function DecisionsPanel({
  decisions, choices, onChange,
}: { decisions: readonly SpecDecision[]; choices: readonly DecisionChoice[]; onChange: (i: number, c: DecisionChoice) => void }) {
  if (decisions.length === 0) return null;
  return (
    <div data-decisions className="mb-3 space-y-3">
      <p className="text-xs text-pretty text-zinc-600 dark:text-zinc-400">
        Decisions for you: each answer goes with approve. The default is selected; change any you disagree with.
      </p>
      {decisions.map((d, i) => {
        const c = choices[i] ?? { own: true, value: "" };
        const label = `${i + 1}. ${d.question}`;
        return (
          <fieldset key={i} data-decision={i + 1} className="min-w-0 max-w-xl">
            <legend className="text-sm font-medium text-pretty break-words">
              {label}
              {d.owner_only && <span className="ml-1 text-xs text-zinc-600 dark:text-zinc-400">(owner only)</span>}
            </legend>
            {d.reason && <p className="text-xs text-pretty break-words text-zinc-600 dark:text-zinc-400">{d.reason}</p>}
            {d.options.length > 0 ? (
              <div role="radiogroup" aria-label={label} className="mt-1 space-y-1">
                {d.options.map((o) => (
                  <label key={o} className="flex items-center gap-2 text-sm break-words">
                    <input type="radio" name={`decision-${i + 1}`} checked={!c.own && c.value === o} onChange={() => onChange(i, { own: false, value: o })} />
                    {o}
                    {o === d.default && <span className="text-xs text-zinc-600 dark:text-zinc-400">(default)</span>}
                  </label>
                ))}
                <label className="flex flex-wrap items-center gap-2 text-sm">
                  <input type="radio" name={`decision-${i + 1}`} checked={c.own} onChange={() => onChange(i, { own: true, value: c.own ? c.value : "" })} />
                  write my own
                </label>
                {c.own && (
                  <input
                    aria-label={`Answer ${i + 1}`}
                    value={c.value}
                    onChange={(e) => onChange(i, { own: true, value: e.target.value })}
                    className={cn(field, "w-full")}
                  />
                )}
              </div>
            ) : (
              <input
                aria-label={`Answer ${i + 1}`}
                value={c.value}
                placeholder={d.default === null ? "Your answer (no default)" : undefined}
                onChange={(e) => onChange(i, { own: true, value: e.target.value })}
                className={cn(field, "mt-1 w-full")}
              />
            )}
          </fieldset>
        );
      })}
    </div>
  );
}

/** The approve confirm step: what is approved (the answers, which defaults are taken) and what happens next. */
export function ApproveConfirm({ phase, answers, note }: { phase: ApprovePhase; answers: readonly ChosenAnswer[]; note: string }) {
  const p = PHASES[phase];
  return (
    <div role="group" aria-label="Confirm approve" data-approve-confirm={phase} className="w-full max-w-xl rounded-md border border-zinc-300 p-2 text-sm dark:border-zinc-700">
      <p className="text-pretty">You approve {p.what}.</p>
      {answers.length > 0 && (
        <ul className="mt-1 list-disc pl-5" data-confirm-answers>
          {answers.map((a) => (
            <li key={a.n} className="break-words">
              {a.n}. {a.question} → {a.answer ?? "no answer"} ({a.answer === null ? "no default" : a.isDefault ? "default taken" : "your answer"})
            </li>
          ))}
        </ul>
      )}
      {note.trim() !== "" && <p className="mt-1 break-words text-zinc-600 dark:text-zinc-400">With your note to the implementer and the reviewer.</p>}
      <p className="mt-1 text-pretty" data-confirm-next>Next: {p.next}</p>
    </div>
  );
}
