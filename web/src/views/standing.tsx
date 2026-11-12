import { useQueryClient } from "@tanstack/react-query";
import { Fragment, type ReactNode, useState } from "react";
import { API, type StandingProposalRow, type StandingRuleRow, type StandingView, postStanding, useApi } from "../api.js";
import { Button } from "../components/ui/button.js";
import { ButtonRow } from "../components/ui/button-row.js";
import { Empty, ErrorNote, Loading, Section } from "../components/ui/parts.js";
import { Switch } from "../components/ui/switch.js";
import type { MessageKey } from "../i18n/en.js";
import { t } from "../i18n/index.js";

// Standing approvals on the Settings page (design 05-standing-approvals and §9, issue #300): an on or off switch per
// rule with its gate, tier, threshold, who set it, when it was created and when it was last used, and Accept and
// Decline per pending proposal (its own section, first on the page). Every write is POST /api/v1/standing with the CSRF token; the server runs the
// owner check (approve_spec), and a refusal shows beside the item it came from.

const muted = "text-xs text-pretty text-text-2";

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

function RuleItem({ rule, token }: { rule: StandingRuleRow; token: string | null }) {
  const { busy, error, write } = useStandingWrite(token);
  return (
    <li data-rule={rule.rule} className="rounded-control border border-border px-3 py-2">
      <div className="flex items-center gap-3">
        <Switch aria-label={rule.rule} checked={rule.enabled} disabled={busy} onCheckedChange={(next) => void write({ rule: rule.rule, enabled: next })} />
        <span className="font-mono text-sm">{rule.rule}</span>
        <span className="text-sm">{rule.enabled ? t("standing.on") : t("standing.off")}</span>
      </div>
      <p className={`mt-1 ${muted}`}>
        {t("standing.facts", { gate: rule.gate, tier: rule.tier, threshold: rule.threshold })}
        {rule.set_by !== null && t("standing.setBy", { name: rule.set_by })}
        {t("standing.created", { when: rule.created_at ?? t("standing.neverStored") })}
        {t("standing.lastUsed", { when: rule.last_used_at ?? t("standing.notRecorded") })}
      </p>
      <Refusal error={error} />
    </li>
  );
}

function ProposalItem({ proposal, token }: { proposal: StandingProposalRow; token: string | null }) {
  const { busy, error, write } = useStandingWrite(token);
  const answer = (enabled: boolean) => void write({ rule: proposal.rule, enabled, proposal: proposal.id });
  return (
    <li data-proposal={proposal.id} className="rounded-control border border-border px-3 py-2">
      <p className="text-sm text-pretty">
        {withNodes("standing.proposal", { rule: <code>{proposal.rule}</code> }, { count: proposal.run_length, threshold: proposal.threshold, when: proposal.created_at })}
      </p>
      <ButtonRow className="mt-3">
        <Button variant="secondary" disabled={busy} onClick={() => answer(true)}>
          {t("standing.accept")}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={() => answer(false)}>
          {t("standing.decline")}
        </Button>
      </ButtonRow>
      <Refusal error={error} />
    </li>
  );
}

/** The standing read, or its loading or error state, inside a section; both sections below read it (one fetch). */
function WithStanding({ title, count, children }: { title: string; count: (v: StandingView) => number; children: (v: StandingView) => ReactNode }) {
  const standing = useApi<StandingView>(API.standing);
  const v = standing.data;
  return (
    <Section title={title} count={v ? count(v) : undefined}>
      {standing.isError ? <ErrorNote error={standing.error} /> : !v ? <Loading rows={2} /> : children(v)}
    </Section>
  );
}

/** The pending proposals, at the top of the Settings page: the one part of it that waits for an answer. */
export function ProposalsSection() {
  return (
    <WithStanding title={t("standing.pending")} count={(v) => v.proposals.length}>
      {(v) =>
        v.proposals.length === 0 ? (
          <Empty>{t("standing.noProposal")}</Empty>
        ) : (
          <ul aria-label={t("standing.pending")} className="space-y-2">
            {v.proposals.map((p) => (
              <ProposalItem key={p.id} proposal={p} token={v.csrf_token} />
            ))}
          </ul>
        )
      }
    </WithStanding>
  );
}

export function StandingSection() {
  return (
    <WithStanding title={t("standing.title")} count={(v) => v.rules.length}>
      {(v) => (
        <>
          <p className={`mb-2 ${muted}`}>
            {t("standing.intro")}
            {v.csrf_token === null && t("standing.noWrite")}
          </p>
          <ul aria-label={t("standing.rules")} className="space-y-2">
            {v.rules.map((r) => (
              <RuleItem key={r.rule} rule={r} token={v.csrf_token} />
            ))}
          </ul>
        </>
      )}
    </WithStanding>
  );
}
