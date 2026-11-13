import { useState } from "react";
import type { SpecDecision, WaitingSpec } from "../api.js";
import type { RefObject } from "react";
import { Dialog } from "../components/ui/dialog.js";
import { Input } from "../components/ui/input.js";
import { Markdown } from "../components/ui/markdown.js";
import { Section } from "../components/ui/parts.js";
import { Radio } from "../components/ui/radio.js";
import { Textarea } from "../components/ui/textarea.js";
import type { MessageKey } from "../i18n/en.js";
import { t } from "../i18n/index.js";

// The item page's spec panel (design §9, issue #526): the waiting spec's In short above Commands, and its decisions
// as questions to answer before `approve`. A decision with options is a radio group with the default selected and
// a `write my own` choice with a text field; one with none is a text field prefilled with the default. The answers
// go out with the approve as `N: <answer>` lines (the controller's parser, src/shared/command-notes.ts), and the
// confirm step names what is approved and what happens next. Reject and revise open a dialog (issue #527, shared
// by the Floor and the item page): reject asks why (a reason and a free text) and says what closes; revise takes one
// optional comment per spec section and sends only the commented ones, each under a `### <Section>` heading.

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
const PHASES: Record<ApprovePhase, { what: MessageKey; next: MessageKey }> = {
  spec_pending: { what: "decisions.whatSpecPending", next: "decisions.nextImplement" },
  max_revisions: { what: "decisions.whatMaxRevisions", next: "decisions.nextImplement" },
  floor_tier: { what: "decisions.whatFloorTier", next: "decisions.nextFloorTier" },
  rule_of_two: { what: "decisions.whatRuleOfTwo", next: "decisions.nextRuleOfTwo" },
};

/** The waiting spec's In short, above Commands. */
export function InShort({ spec }: { spec: WaitingSpec | null | undefined }) {
  if (!spec?.in_short) return null;
  return (
    <Section title={t("decisions.inShort")}>
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
      <p className="text-xs text-pretty text-text-2">
        {t("decisions.intro")}
      </p>
      {decisions.map((d, i) => {
        const c = choices[i] ?? { own: true, value: "" };
        const label = `${i + 1}. ${d.question}`;
        return (
          <fieldset key={i} data-decision={i + 1} className="min-w-0 max-w-xl">
            <legend className="text-sm font-medium text-pretty break-words">
              {label}
              {d.owner_only && <span className="ml-1 text-xs text-text-2">{t("decisions.ownerOnly")}</span>}
            </legend>
            {d.reason && <p className="text-xs text-pretty break-words text-text-2">{d.reason}</p>}
            {d.options.length > 0 ? (
              <div role="radiogroup" aria-label={label} className="mt-1 space-y-1">
                {d.options.map((o) => (
                  <Radio key={o} name={`decision-${i + 1}`} checked={!c.own && c.value === o} onChange={() => onChange(i, { own: false, value: o })}>
                    {o}
                    {o === d.default && <span className="text-xs text-text-2">{t("decisions.default")}</span>}
                  </Radio>
                ))}
                <Radio name={`decision-${i + 1}`} checked={c.own} onChange={() => onChange(i, { own: true, value: c.own ? c.value : "" })}>
                  {t("decisions.writeOwn")}
                </Radio>
                {c.own && (
                  <Input aria-label={t("decisions.answer", { n: i + 1 })} value={c.value} onChange={(e) => onChange(i, { own: true, value: e.target.value })} className="w-full" />
                )}
              </div>
            ) : (
              <Input
                aria-label={t("decisions.answer", { n: i + 1 })}
                value={c.value}
                placeholder={d.default === null ? t("decisions.noDefaultPlaceholder") : undefined}
                onChange={(e) => onChange(i, { own: true, value: e.target.value })}
                className="mt-1 w-full"
              />
            )}
          </fieldset>
        );
      })}
    </div>
  );
}

/** A command's button and dialog label in sentence case: Approve, Retry, Revise. */
export const commandLabel = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1);

/**
 * The approve dialog (the four approve phases): what is approved (each question with its answer, and whether it is
 * the default), an optional note, then what happens next; Cancel on the left, Approve on the right. The note starts
 * as the page's note box text; confirming sends the answers and the note as the approve note.
 */
export function ApproveDialog({
  title, phase, answers, note: initialNote, busy, error, returnFocusTo, onSend, onClose,
}: CommandDialogProps & { phase: ApprovePhase; answers: readonly ChosenAnswer[]; note: string }) {
  const [note, setNote] = useState(initialNote);
  const p = PHASES[phase];
  return (
    <Dialog
      title={title}
      consequence={<span data-confirm-next>{t("decisions.next", { next: t(p.next) })}</span>}
      confirmLabel={commandLabel("approve")}
      confirmDisabled={busy}
      error={error}
      returnFocusTo={returnFocusTo}
      onConfirm={() => onSend(approveNote(answers, note))}
      onClose={onClose}
    >
      <div role="group" aria-label={t("decisions.confirmApprove")} data-approve-confirm={phase} className="text-sm">
        <p className="text-pretty">{t("decisions.youApprove", { what: t(p.what) })}</p>
        {answers.length > 0 && (
          <ul className="mt-1 list-disc pl-5" data-confirm-answers>
            {answers.map((a) => (
              <li key={a.n} className="break-words">
                {a.n}. {a.question} → {a.answer ?? t("decisions.noAnswer")} ({a.answer === null ? t("decisions.noDefault") : a.isDefault ? t("decisions.defaultTaken") : t("decisions.yourAnswer")})
              </li>
            ))}
          </ul>
        )}
      </div>
      <Textarea aria-label={t("commands.note")} rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("decisions.optionalComment")} className="w-full" />
    </Dialog>
  );
}

/** What every command dialog takes: its title (the action and the item's title), whether a send is in flight, the failed send's error, and the focus target. */
export interface CommandDialogProps {
  title: string;
  busy: boolean;
  error: string | null;
  returnFocusTo: RefObject<HTMLElement | null>;
  onSend: (note: string) => void;
  onClose: () => void;
}

/** Why a spec is rejected: one of these, and any free text. */
export const REJECT_REASONS = ["not needed", "wrong approach", "duplicate", "too big; split it"] as const;

/** The shown label of each reject reason; the reason itself is what the server receives. */
const REJECT_LABEL: Record<(typeof REJECT_REASONS)[number], MessageKey> = {
  "not needed": "decisions.reasonNotNeeded",
  "wrong approach": "decisions.reasonWrongApproach",
  duplicate: "decisions.reasonDuplicate",
  "too big; split it": "decisions.reasonTooBig",
};

/** The reject note: the chosen reason, then the free text, one line each. */
export function rejectNote(reason: string | null, text: string): string {
  return [reason ?? "", text.trim()].filter(Boolean).join("\n");
}

/** The reject dialog: why (a reason and a free text), what closes (the item, and its PR when it has one), confirm or cancel. */
export function RejectDialog({ title, pr, busy, error, returnFocusTo, onSend, onClose }: CommandDialogProps & { pr: string | null }) {
  const [reason, setReason] = useState<string | null>(null);
  const [text, setText] = useState("");
  const note = rejectNote(reason, text);
  return (
    <Dialog
      title={title}
      consequence={pr === null ? t("decisions.rejectConsequence") : t("decisions.rejectConsequencePr", { pr })}
      confirmLabel={t("decisions.confirmReject")}
      confirmDisabled={busy || note === ""}
      danger
      error={error}
      returnFocusTo={returnFocusTo}
      onConfirm={() => onSend(note)}
      onClose={onClose}
    >
      <fieldset className="min-w-0">
        <legend className="text-sm font-medium">{t("decisions.why")}</legend>
        <div role="radiogroup" aria-label={t("decisions.reason")} className="mt-1 space-y-1">
          {REJECT_REASONS.map((r) => (
            <Radio key={r} name="reject-reason" checked={reason === r} onChange={() => setReason(r)}>
              {t(REJECT_LABEL[r])}
            </Radio>
          ))}
        </div>
      </fieldset>
      <Textarea
        aria-label={t("decisions.rejectDetails")}
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={t("decisions.sayMore")}
        className="w-full"
      />
    </Dialog>
  );
}

/** The spec sections a revise comments on, in the spec comment's order. */
export const SPEC_SECTIONS = ["In short", "Problem", "Done when", "Scope", "Allowed paths"] as const;

/** The shown label of each spec section; the section name itself heads the text the server receives. */
const SECTION_LABEL: Record<(typeof SPEC_SECTIONS)[number], MessageKey> = {
  "In short": "decisions.sectionInShort",
  Problem: "decisions.sectionProblem",
  "Done when": "decisions.sectionDoneWhen",
  Scope: "decisions.sectionScope",
  "Allowed paths": "decisions.sectionAllowedPaths",
};

/** The revise text: each commented section under its `### <Section>` heading; an uncommented one is left out. */
export function reviseNote(comments: readonly string[]): string {
  return SPEC_SECTIONS.flatMap((s, i) => {
    const c = comments[i]?.trim();
    return c ? [`### ${s}\n${c}`] : [];
  }).join("\n\n");
}

/** The revise dialog: one optional comment per spec section, sent as one revise once any section has a comment. */
export function ReviseDialog({ title, busy, error, returnFocusTo, onSend, onClose }: CommandDialogProps) {
  const [comments, setComments] = useState<string[]>(() => SPEC_SECTIONS.map(() => ""));
  const note = reviseNote(comments);
  return (
    <Dialog
      title={title}
      consequence={t("decisions.reviseConsequence")}
      confirmLabel={t("decisions.sendRevise")}
      confirmDisabled={busy || note === ""}
      error={error}
      returnFocusTo={returnFocusTo}
      onConfirm={() => onSend(note)}
      onClose={onClose}
    >
      {SPEC_SECTIONS.map((s, i) => (
        <div key={s} data-revise-section={s} className="flex flex-col gap-1">
          <span className="text-sm font-medium">{t(SECTION_LABEL[s])}</span>
          <Textarea
            aria-label={t("decisions.commentOn", { section: t(SECTION_LABEL[s]) })}
            rows={2}
            value={comments[i]}
            onChange={(e) => setComments(comments.map((x, j) => (j === i ? e.target.value : x)))}
            placeholder={t("decisions.optionalComment")}
            className="w-full"
          />
        </div>
      ))}
    </Dialog>
  );
}
