import { Pause, Pencil, Play, Trash2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Fragment, type ReactNode, useId, useRef, useState } from "react";
import { API, type StandingProposalRow, type StandingRuleRow, type StandingView, type StandingWriteBody, postStanding, useApi } from "../api.js";
import { Button } from "../components/ui/button.js";
import { Dialog } from "../components/ui/dialog.js";
import { Field } from "../components/ui/field.js";
import { Input } from "../components/ui/input.js";
import { ErrorNote } from "../components/ui/parts.js";
import { Switch } from "../components/ui/switch.js";
import type { MessageKey } from "../i18n/en.js";
import { t } from "../i18n/index.js";
import { Card, CardSection } from "../components/ui/card.js";
import { localDateTime, relativeTime } from "../lib/format.js";
import { RawDetails, useNow, useViewer } from "./common.js";
import { ListRow, ROW_TITLE } from "../components/ui/list-row.js";
import { OverflowMenu } from "../components/ui/menu.js";
import { BLOCK_LINK_CLASS, LINK_CLASS } from "../components/ui/link-style.js";
import { cn } from "../lib/cn.js";
import { Link } from "../nav.js";
import { itemPath } from "../pages.js";
import { ROW_PAD } from "./rules-shared.js";

// Standing approvals on the Rules page (design 05-standing-approvals and §9, issue #300; two sections since 2026-11-22):
// each rule that is on is a row of In effect, its Switch, its plain sentence, when it last fired and the items it
// approved in the last 7 days (linked by title); behind Details its ID, gate, tier, threshold, who set it ("you" for the
// viewer, else "a person"; never the user ID) and when it was created. A rule that is off is a row under the page's
// Details. Each pending proposal is a row of Waiting for you: Accept visible beside its ⋯ menu, Decline in that menu. With the ledger
// off the same rows sit in one card (ApprovalsSection). A rule is turned on (add), paused, edited (the threshold) or
// removed in a Dialog, from its Switch or its ⋯ menu, never in the row; each dialog lists the waiting items the change
// would approve now, or "none". Every write is POST /api/v1/standing with the CSRF token; the server runs the owner
// check (approve_spec), and a refusal shows in the dialog, or beside the proposal it came from.

/** The most titles a standing row names before "+N more". */
const RECENT_SHOWN = 2;

const muted = "text-xs text-pretty break-keep text-text-2";

/** A standing rule in one plain sentence ("Approves tier 1 plans for you"); its ID, gate and tier stay in Details. */
const ruleSentence = (tier: number): string => t("standing.sentence", { tier });
/** A proposal's tier, from its rule ID (`spec-t1` is tier 1); 1, the only rule today, when the ID does not say. */
const proposalTier = (rule: string): number => Number(/-t(\d+)$/.exec(rule)?.[1] ?? 1);

/** Who set a rule, by the existing person words: the viewer is "you", anyone else "a person"; the ID never shows. */
const setBy = (id: string, viewer: string | null): string => t(id === viewer ? "person.you" : "person.other");

/** The text of `key` with each `{name}` in `nodes` replaced by that element (a sentence with <code> in it); `vars` fill plain values. */
export function withNodes(key: MessageKey, nodes: Record<string, ReactNode>, vars: Record<string, string | number> = {}): ReactNode[] {
  return t(key, vars).split(/(\{\w+\})/).map((part, i) => {
    const name = /^\{(\w+)\}$/.exec(part)?.[1];
    return name !== undefined && name in nodes ? <Fragment key={i}>{nodes[name]}</Fragment> : part;
  });
}

/** One write and its refusal, kept beside its item until the next try. */
function useStandingWrite(token: string | null) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Sends `body`; true once the server took it (and the read is refreshed), false on a refusal, kept in `error`. */
  const write = async (body: StandingWriteBody): Promise<boolean> => {
    if (token === null) return false;
    setBusy(true);
    setError(null);
    try {
      const r = await postStanding(token, body);
      if (!r.ok) {
        setError(r.error);
        return false;
      }
      await client.invalidateQueries({ queryKey: [API.standing] });
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy: busy || token === null, error, write };
}

function Refusal({ error }: { error: string | null }) {
  return error ? <p role="alert" className="mt-1 text-xs text-pretty break-words text-pill-bad-fg">{error}</p> : null;
}

/** "last fired 5m ago" from the newest firing, or "never fired". */
function firedText(at: string | null, now: number): string {
  return at === null ? t("standing.neverFired") : t("standing.lastFired", { when: relativeTime(at, now) });
}

/** What a rule's dialog changes: turn it on (add, creating its row), turn it off (pause), the threshold (edit), or delete its row (remove). */
export type RuleAction = "add" | "pause" | "edit" | "remove";

/**
 * One standing rule as a ListRow: its Switch, its sentence, then when it last fired and the items it
 * approved in the last 7 days, at most two links named by their title (no ID), then "+N more" that opens Details; its raw facts behind Details. The Switch and
 * the ⋯ menu (Turn on or Pause, Edit, Remove) each open the rule's Dialog; the row itself never grows.
 */
export function StandingRule({ rule, token }: { rule: StandingRuleRow; token: string | null }) {
  const [action, setAction] = useState<RuleAction | null>(null);
  const viewer = useViewer();
  const now = useNow();
  const sentence = ruleSentence(rule.tier);
  // A server from before the firings were read sends neither field: no firing then.
  const recent = rule.recent ?? [];
  const firedAt = rule.last_fired_at ?? null;
  const off = token === null;
  // At most two titles on the row; "+N more" opens the row's Details, which list them all.
  const shown = recent.slice(0, RECENT_SHOWN);
  const hidden = recent.length - shown.length;
  const row = useRef<HTMLLIElement>(null);
  const openDetails = () => {
    const summary = row.current?.querySelector<HTMLElement>("details[data-raw] > summary");
    if (summary?.getAttribute("aria-expanded") === "false") summary.click();
  };
  return (
    <ListRow
      ref={row}
      data-rule={rule.rule}
      className={ROW_PAD}
      leading={<Switch aria-label={sentence} checked={rule.enabled} disabled={off} onCheckedChange={(next) => setAction(next ? "add" : "pause")} />}
      title={<p data-rule-sentence className={`${ROW_TITLE} font-medium`} title={sentence}>{sentence}</p>}
      details={
        <>
          <span data-fired>{firedText(firedAt, now)}</span>
          {/* An inline list as a wrapping flex line: each title is one line cut with an ellipsis (BLOCK_LINK_CLASS), its comma
              kept in the same box so a separator never sits alone on a line, and every box is the 24px link height. */}
          <span data-recent className="flex min-w-0 flex-wrap items-center gap-x-1">
            <span className="break-keep">
              {recent.length === 1 ? t("standing.recentOne") : t("standing.recent", { count: recent.length })}
              {recent.length > 0 && <span className="max-sm:hidden">: </span>}
            </span>
            {/* Below `sm` the titles would stack as cut underlines: the count stays, and Show opens Details, which lists them. */}
            {shown.map((item, i) => (
              <span key={item.id} data-recent-item className="flex max-w-full min-w-0 items-center max-sm:hidden sm:max-w-[40ch]">
                <Link href={itemPath(item.id)} data-raw title={item.title} className={cn(BLOCK_LINK_CLASS, "min-w-0 truncate leading-6")}>{item.title}</Link>
                {(i < shown.length - 1 || hidden > 0) && <span className="shrink-0">, </span>}
              </span>
            ))}
            {hidden > 0 && (
              <Button variant="ghost" size="sm" data-recent-more className={`min-h-0 px-1 max-sm:hidden ${LINK_CLASS}`} onClick={openDetails}>{t("standing.recentMore", { count: hidden })}</Button>
            )}
          </span>
          {recent.length > 0 && (
            <Button variant="ghost" size="sm" data-recent-show className={`min-h-0 px-1 sm:hidden ${LINK_CLASS}`} onClick={openDetails}>{t("standing.recentShow")}</Button>
          )}
        </>
      }
      menu={
        <OverflowMenu
          label={t("standing.actions", { rule: sentence })}
          items={[
            rule.enabled
              ? { label: t("standing.pause"), icon: Pause, action: "pause", disabled: off, onSelect: () => setAction("pause") }
              : { label: t("standing.turnOn"), icon: Play, action: "add", disabled: off, onSelect: () => setAction("add") },
            { label: t("standing.edit"), icon: Pencil, action: "edit", disabled: off, onSelect: () => setAction("edit") },
            { separator: true },
            // A rule with no stored row has nothing to remove.
            { label: t("standing.remove"), icon: Trash2, action: "remove", danger: true, disabled: off || rule.created_at === null, onSelect: () => setAction("remove") },
          ]}
        />
      }
    >
      <RawDetails>
        {recent.length > 0 && (
          <ul data-recent-all className={`mb-1 ${muted}`}>
            {recent.map((item) => <li key={item.id}><Link href={itemPath(item.id)} className={LINK_CLASS}>{item.title}</Link></li>)}
          </ul>
        )}
        <p className={muted}>
          {t("standing.ruleId", { rule: rule.rule })}
          {" · "}
          {t("standing.facts", { gate: rule.gate, tier: rule.tier, threshold: rule.threshold })}
          {rule.set_by !== null && t("standing.setBy", { name: setBy(rule.set_by, viewer) })}
          {t("standing.created", { when: rule.created_at === null ? t("standing.neverStored") : localDateTime(rule.created_at) })}
          {firedAt !== null && t("standing.firedAt", { when: localDateTime(firedAt) })}
        </p>
      </RawDetails>
      {action !== null && <RuleDialog rule={rule} action={action} token={token} onClose={() => setAction(null)} />}
    </ListRow>
  );
}

/** A threshold the field holds: a whole number above 0, else null. */
const thresholdOf = (text: string): number | null => (/^\d+$/.test(text.trim()) && Number(text) > 0 ? Number(text) : null);

/**
 * The Dialog of one rule change. Add and Pause show the rule's Switch (the state to save), Edit the threshold Field,
 * Remove only its consequence with a danger confirm. Each lists, before the confirm, the waiting items the change
 * would approve now (`waiting` of the read, when the change leaves the rule on), or "none". It closes once the server
 * took the change; a refusal stays in it.
 */
function RuleDialog({ rule, action, token, onClose }: { rule: StandingRuleRow; action: RuleAction; token: string | null; onClose: () => void }) {
  const { busy, error, write } = useStandingWrite(token);
  // The read the page already holds (one query per URL): its preview of the waiting items.
  const waiting = useApi<StandingView>(API.standing).data?.waiting ?? [];
  const [on, setOn] = useState(action === "add");
  const [threshold, setThreshold] = useState(String(rule.threshold));
  const fieldId = useId();
  const sentence = ruleSentence(rule.tier);
  const toggles = action === "add" || action === "pause";
  const asked = thresholdOf(threshold);
  const approves = toggles && on ? waiting : [];
  const send = async () => {
    const body: StandingWriteBody = action === "remove" ? { rule: rule.rule, action: "remove" }
      : action === "edit" ? { rule: rule.rule, action: "edit", threshold: asked! }
      : { rule: rule.rule, enabled: on };
    if (await write(body)) onClose();
  };
  const title = action === "remove" ? t("standing.removeTitle", { rule: sentence })
    : action === "edit" ? t("standing.editTitle", { rule: sentence })
    : t(on ? "standing.turnOnTitle" : "standing.pauseTitle", { rule: sentence });
  const consequence = action === "remove" ? t("standing.removeConsequence")
    : action === "edit" ? t("standing.editConsequence")
    : t(on ? "standing.onConsequence" : "standing.pauseConsequence", { tier: rule.tier });
  const confirm = action === "remove" ? t("standing.remove") : action === "edit" ? t("standing.save") : t(on ? "standing.turnOn" : "standing.pause");
  // Nothing to send: the state the rule already has, or a threshold that is not a whole number above 0.
  const idle = toggles ? on === rule.enabled : action === "edit" ? asked === null : false;
  return (
    <Dialog
      title={title}
      consequence={consequence}
      confirmLabel={confirm}
      confirmDisabled={busy || idle}
      danger={action === "remove"}
      error={error}
      onConfirm={() => void send()}
      onClose={onClose}
    >
      {toggles && (
        <div data-rule-state className="flex items-center gap-2 text-sm">
          <Switch aria-label={sentence} checked={on} disabled={busy} onCheckedChange={setOn} />
          <span>{on ? t("standing.on") : t("standing.off")}</span>
        </div>
      )}
      {action === "edit" && (
        <Field label={t("standing.thresholdLabel")} htmlFor={fieldId} help={t("standing.thresholdHelp")}>
          <Input id={fieldId} type="number" min={1} step={1} inputMode="numeric" value={threshold} disabled={busy} onChange={(e) => setThreshold(e.target.value)} />
        </Field>
      )}
      <div data-preview className="text-sm">
        <p className="font-medium">{t("standing.previewTitle")}</p>
        {approves.length === 0 ? (
          <p data-preview-none className="text-text-2">{t("standing.previewNone")}</p>
        ) : (
          <ul className="mt-1 list-disc pl-5">
            {approves.map((item) => <li key={item.id} className="break-words">{item.title}</li>)}
          </ul>
        )}
      </div>
    </Dialog>
  );
}

/** A proposal to turn a rule on, as a ListRow: Accept is its one visible action, at the right of its title; Decline sits in its ⋯ menu. */
export function StandingProposal({ proposal, token }: { proposal: StandingProposalRow; token: string | null }) {
  const { busy, error, write } = useStandingWrite(token);
  const answer = (enabled: boolean) => void write({ rule: proposal.rule, enabled, proposal: proposal.id });
  const sentence = ruleSentence(proposalTier(proposal.rule));
  return (
    <ListRow
      data-proposal={proposal.id}
      className={ROW_PAD}
      title={<p className={`${ROW_TITLE} font-medium`} title={sentence}>{withNodes("standing.proposalTitle", { rule: <span data-rule-sentence>{sentence}</span> })}</p>}
      details={<span className="break-keep">{t("standing.proposal", { count: proposal.run_length, threshold: proposal.threshold, when: localDateTime(proposal.created_at) })}</span>}
      action={
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => answer(true)}>
          {t("standing.accept")}
        </Button>
      }
      menu={<OverflowMenu label={t("standing.actions", { rule: sentence })} items={[{ label: t("standing.decline"), action: "decline", disabled: busy, onSelect: () => answer(false) }]} />}
    >
      <Refusal error={error} />
    </ListRow>
  );
}

/**
 * The Auto-approve specs section of the Rules page (its title is also its region name): the pending proposals, then the standing rules, from one read. Each part is
 * hidden when it has no items, and the whole section when both are empty, so nothing on the page asks for a decision
 * that is not there. While the read loads there is nothing to show; a failed read shows its error.
 */
export function ApprovalsSection() {
  const standing = useApi<StandingView>(API.standing);
  const v = standing.data;
  if (standing.isError) return <Card title={t("rules.approvals")}><ErrorNote error={standing.error} /></Card>;
  if (!v || (v.proposals.length === 0 && v.rules.length === 0)) return null;
  return (
    <Card title={t("rules.approvals")}>
      {v.proposals.length > 0 && (
        <CardSection title={t("standing.pending")}>
          <ul aria-label={t("standing.pending")} className="divide-y divide-border rounded-control border border-border">
            {v.proposals.map((p) => (
              <StandingProposal key={p.id} proposal={p} token={v.csrf_token} />
            ))}
          </ul>
        </CardSection>
      )}
      {v.rules.length > 0 && (
        <CardSection title={t("standing.title")}>
          <p className={`mb-2 ${muted}`}>
            {t("standing.intro")}
            {v.csrf_token === null && t("standing.noWrite")}
          </p>
          <ul aria-label={t("standing.rules")} className="divide-y divide-border rounded-control border border-border">
            {v.rules.map((r) => (
              <StandingRule key={r.rule} rule={r} token={v.csrf_token} />
            ))}
          </ul>
        </CardSection>
      )}
    </Card>
  );
}
