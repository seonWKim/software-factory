import { useQueryClient } from "@tanstack/react-query";
import { Fragment, type ReactNode, useState } from "react";
import { API, type StandingProposalRow, type StandingRuleRow, type StandingView, postStanding, useApi } from "../api.js";
import { Button } from "../components/ui/button.js";
import { ButtonRow } from "../components/ui/button-row.js";
import { ErrorNote } from "../components/ui/parts.js";
import { Switch } from "../components/ui/switch.js";
import type { MessageKey } from "../i18n/en.js";
import { t } from "../i18n/index.js";
import { Card, CardSection } from "../components/ui/card.js";
import { localDateTime, relativeTime } from "../lib/format.js";
import { RawDetails, useNow, useViewer } from "./common.js";
import { ListRow, ROW_TITLE } from "../components/ui/list-row.js";
import { OverflowMenu } from "../components/ui/menu.js";
import { LINK_CLASS } from "../components/ui/link-style.js";
import { Link } from "../nav.js";
import { itemPath } from "../pages.js";
import { ROW_PAD } from "./rules-shared.js";

// Standing approvals on the Rules page (design 05-standing-approvals and §9, issue #300; two sections since 2026-11-22):
// each rule that is on is a row of In effect, its Switch, its plain sentence, when it last fired and the items it
// approved in the last 7 days (linked by title); behind Details its ID, gate, tier, threshold, who set it ("you" for the
// viewer, else "a person"; never the user ID) and when it was created. A rule that is off is a row under the page's
// Details. Each pending proposal is a row of Waiting for you: Accept visible, Decline in its ⋯ menu. With the ledger
// off the same rows sit in one card (ApprovalsSection). Every write is POST /api/v1/standing with the CSRF token; the
// server runs the owner check (approve_spec), and a refusal shows beside the item it came from.

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
  const write = async (body: { rule: string; enabled: boolean; proposal?: string }) => {
    if (token === null) return;
    setBusy(true);
    setError(null);
    try {
      const r = await postStanding(token, body);
      if (!r.ok) setError(r.error);
      else await client.invalidateQueries({ queryKey: [API.standing] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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

/**
 * One standing rule as a ListRow: its Switch, its sentence, then on or off, when it last fired and the items it
 * approved in the last 7 days, each a link named by its title (no ID); its raw facts behind Details.
 */
export function StandingRule({ rule, token }: { rule: StandingRuleRow; token: string | null }) {
  const { busy, error, write } = useStandingWrite(token);
  const viewer = useViewer();
  const now = useNow();
  const sentence = ruleSentence(rule.tier);
  // A server from before the firings were read sends neither field: no firing then.
  const recent = rule.recent ?? [];
  const firedAt = rule.last_fired_at ?? null;
  return (
    <ListRow
      data-rule={rule.rule}
      className={ROW_PAD}
      leading={<Switch aria-label={sentence} checked={rule.enabled} disabled={busy} onCheckedChange={(next) => void write({ rule: rule.rule, enabled: next })} />}
      title={<p data-rule-sentence className={`${ROW_TITLE} font-medium`} title={sentence}>{sentence}</p>}
      details={
        <>
          <span>{rule.enabled ? t("standing.on") : t("standing.off")}</span>
          <span data-fired>{firedText(firedAt, now)}</span>
          <span data-recent className="min-w-0 break-keep">
            {recent.length === 1 ? t("standing.recentOne") : t("standing.recent", { count: recent.length })}
            {recent.map((item, i) => (
              <Fragment key={item.id}>
                {i === 0 ? ": " : ", "}
                <Link href={itemPath(item.id)} className={LINK_CLASS}>{item.title}</Link>
              </Fragment>
            ))}
          </span>
        </>
      }
    >
      <RawDetails>
        <p className={muted}>
          {t("standing.ruleId", { rule: rule.rule })}
          {" · "}
          {t("standing.facts", { gate: rule.gate, tier: rule.tier, threshold: rule.threshold })}
          {rule.set_by !== null && t("standing.setBy", { name: setBy(rule.set_by, viewer) })}
          {t("standing.created", { when: rule.created_at === null ? t("standing.neverStored") : localDateTime(rule.created_at) })}
          {firedAt !== null && t("standing.firedAt", { when: localDateTime(firedAt) })}
        </p>
      </RawDetails>
      <Refusal error={error} />
    </ListRow>
  );
}

/** A proposal to turn a rule on, as a ListRow: Accept is its one visible action; Decline sits in its ⋯ menu. */
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
      menu={<OverflowMenu label={t("standing.actions", { rule: sentence })} items={[{ label: t("standing.decline"), action: "decline", disabled: busy, onSelect: () => answer(false) }]} />}
    >
      <ButtonRow>
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => answer(true)}>
          {t("standing.accept")}
        </Button>
      </ButtonRow>
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
