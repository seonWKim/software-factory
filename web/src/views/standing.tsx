import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { API, type StandingProposalRow, type StandingRuleRow, type StandingView, postStanding, useApi } from "../api.js";
import { Button } from "../components/ui/button.js";
import { Empty, ErrorNote, Loading, Section } from "../components/ui/parts.js";
import { Switch } from "../components/ui/switch.js";

// Standing approvals on the Settings page (design 05-standing-approvals and §9, issue #300): an on or off switch per
// rule with its gate, tier, threshold, who set it, when it was created and when it was last used, and Accept and
// Decline per pending proposal. Every write is POST /api/v1/standing with the CSRF token; the server runs the
// owner check (approve_spec), and a refusal shows beside the item it came from.

const muted = "text-xs text-pretty text-zinc-600 dark:text-zinc-400";

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
  return error ? <p role="alert" className="mt-1 text-xs text-pretty break-words text-red-700 dark:text-red-300">{error}</p> : null;
}

function RuleItem({ rule, token }: { rule: StandingRuleRow; token: string | null }) {
  const { busy, error, write } = useStandingWrite(token);
  return (
    <li data-rule={rule.rule} className="rounded-md border border-zinc-200 px-3 py-2 dark:border-zinc-800">
      <div className="flex items-center gap-3">
        <Switch aria-label={rule.rule} checked={rule.enabled} disabled={busy} onCheckedChange={(next) => void write({ rule: rule.rule, enabled: next })} />
        <span className="font-mono text-sm">{rule.rule}</span>
        <span className="text-sm">{rule.enabled ? "on" : "off"}</span>
      </div>
      <p className={`mt-1 ${muted}`}>
        gate {rule.gate} · tier {rule.tier} · threshold {rule.threshold} (standing_approvals.threshold)
        {rule.set_by !== null && ` · set by ${rule.set_by}`}
        {` · created ${rule.created_at ?? "never stored"}`}
        {` · last used ${rule.last_used_at ?? "not recorded"}`}
      </p>
      <Refusal error={error} />
    </li>
  );
}

function ProposalItem({ proposal, token }: { proposal: StandingProposalRow; token: string | null }) {
  const { busy, error, write } = useStandingWrite(token);
  const answer = (enabled: boolean) => void write({ rule: proposal.rule, enabled, proposal: proposal.id });
  return (
    <li data-proposal={proposal.id} className="rounded-md border border-zinc-200 px-3 py-2 dark:border-zinc-800">
      <p className="text-sm text-pretty">
        Turn on <code>{proposal.rule}</code>: {proposal.run_length} approvals in a row with the spec unchanged (threshold {proposal.threshold}),
        proposed {proposal.created_at}.
      </p>
      <div className="mt-2 flex gap-2">
        <Button variant="outline" className="h-8 w-auto px-2" disabled={busy} onClick={() => answer(true)}>
          Accept
        </Button>
        <Button variant="outline" className="h-8 w-auto px-2" disabled={busy} onClick={() => answer(false)}>
          Decline
        </Button>
      </div>
      <Refusal error={error} />
    </li>
  );
}

export function StandingSection() {
  const standing = useApi<StandingView>(API.standing);
  const v = standing.data;
  return (
    <Section title="Standing approvals" count={v?.rules.length}>
      {standing.isError ? (
        <ErrorNote error={standing.error} />
      ) : !v ? (
        <Loading rows={2} />
      ) : (
        <>
          <p className={`mb-2 ${muted}`}>
            A rule that is on approves the specs of its tier that wait at its gate without a reply. Changing one needs approve_spec.
            {v.csrf_token === null && " This server has no write route; use /standing on a work item."}
          </p>
          <ul aria-label="Standing rules" className="space-y-2">
            {v.rules.map((r) => (
              <RuleItem key={r.rule} rule={r} token={v.csrf_token} />
            ))}
          </ul>
          <h3 className="mt-4 mb-2 text-sm font-semibold">Pending proposals</h3>
          {v.proposals.length === 0 ? (
            <Empty>No proposal is waiting.</Empty>
          ) : (
            <ul aria-label="Pending proposals" className="space-y-2">
              {v.proposals.map((p) => (
                <ProposalItem key={p.id} proposal={p} token={v.csrf_token} />
              ))}
            </ul>
          )}
        </>
      )}
    </Section>
  );
}
