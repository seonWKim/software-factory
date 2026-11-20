import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useApi } from "../api.js";
import { PROPOSALS_API, type ProposalEvidence, type ProposalRow, type ProposalVerdict, type ProposalsView, postProposalVerdict } from "../api/proposals.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { ButtonRow } from "../components/ui/button-row.js";
import { Card } from "../components/ui/card.js";
import { Disclosure } from "../components/ui/disclosure.js";
import { KeyValue, ValueBlock } from "../components/ui/key-value.js";
import { EmptyState, PageHeader } from "../components/ui/notice.js";
import { ErrorNote, Loading } from "../components/ui/parts.js";
import type { MessageKey } from "../i18n/en.js";
import { t } from "../i18n/index.js";
import { errorLabel, localDateTime, relativeTime } from "../lib/format.js";

// The Proposals page (design 09-dashboard-proposals, issue #496): the improve run's suggested changes to an entity file,
// each with its golden evidence (catch and false-alarm rates before and after, the cases replayed) and the change behind
// "Show the change". A waiting or held one has Promote, Hold and Reject; the verdict is POST /api/v1/proposals/verdict
// with the CSRF token, and nothing changes before it. A refusal shows on its own line under the proposal.

const muted = "text-xs text-pretty text-text-2";
const LEVEL: Readonly<Record<string, string>> = { pending: "warn", held: "info", promoted: "ok", rejected: "bad" };
const STATES: Readonly<Record<string, MessageKey>> = {
  pending: "proposals.state.pending", held: "proposals.state.held", promoted: "proposals.state.promoted", rejected: "proposals.state.rejected",
  watching: "proposals.state.watching", skipped: "proposals.state.skipped", withheld: "proposals.state.withheld",
};
const REASONS: Readonly<Record<string, MessageKey>> = {
  proposal_cap: "proposals.reason.proposal_cap", draft_failed: "proposals.reason.draft_failed", replay_failed: "proposals.reason.replay_failed",
};
const pct = (v: number | null | undefined) => (v === null || v === undefined ? t("proposals.notMeasured") : `${Math.round(v * 100)}%`);

function Evidence({ before, after }: { before: ProposalEvidence; after: ProposalEvidence }) {
  const rate = (k: "catch_rate" | "false_alarm_rate") => t("proposals.beforeAfter", { before: pct(before[k]), after: pct(after[k]) });
  return (
    <KeyValue
      data-evidence
      items={[
        { key: "catch", term: t("proposals.catch"), value: rate("catch_rate") },
        { key: "alarm", term: t("proposals.falseAlarm"), value: rate("false_alarm_rate") },
        { key: "cases", term: t("proposals.cases"), value: t("proposals.caseCount", { count: after.cases.length }) },
      ]}
    />
  );
}

/** The state's word, and why for one that offers no verdict. */
function stateLine(p: ProposalRow): string | null {
  if (p.state === "watching") return t("proposals.watchingHelp", { count: p.run_count });
  if (p.state === "withheld") return t("proposals.withheldHelp", { rules: (p.rules ?? []).join(", ") });
  if (p.state === "skipped" && p.reason) return REASONS[p.reason] ? t(REASONS[p.reason]!) : p.reason.replaceAll("_", " ");
  return p.filed ? t("proposals.filed") : null;
}

function ProposalItem({ p, token }: { p: ProposalRow; token: string | null }) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const decide = async (verdict: ProposalVerdict) => {
    if (token === null) return;
    setBusy(true);
    setNote(null);
    try {
      const r = await postProposalVerdict(token, { id: p.id, verdict });
      if (!r.ok) setNote(r.error);
      else if (r.unchanged) setNote(t("proposals.unchanged"));
      await client.invalidateQueries({ queryKey: [PROPOSALS_API.list] });
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const open = p.state === "pending" || p.state === "held";
  const line = stateLine(p);
  return (
    <li data-proposal={p.id} className="flex flex-col gap-2 rounded-control border border-border px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 text-sm text-pretty">{t("proposals.title", { file: p.file, failure: errorLabel(p.error_code), count: p.run_count })}</span>
        <Badge level={LEVEL[p.state]}>{STATES[p.state] ? t(STATES[p.state]!) : p.state}</Badge>
        <span className={muted} title={localDateTime(p.created_at)}>{t("proposals.when", { when: relativeTime(p.created_at, Date.now()) })}</span>
      </div>
      {line && <p className={muted}>{line}</p>}
      {p.why && <p className="text-sm text-pretty">{`${t("proposals.why")}: ${p.why}`}</p>}
      {p.before && p.after && <Evidence before={p.before} after={p.after} />}
      {p.diff && (
        <Disclosure summary={t("proposals.showChange")}>
          <ValueBlock>{p.diff}</ValueBlock>
        </Disclosure>
      )}
      {open && p.needs_human_merge && <p className={muted}>{t("proposals.humanMerge")}</p>}
      {open && (token === null ? <p className={muted}>{t("proposals.noDecide")}</p> : (
        <ButtonRow>
          <Button variant="primary" disabled={busy} onClick={() => void decide("promote")}>{t("proposals.promote")}</Button>
          <Button variant="secondary" disabled={busy || p.state === "held"} onClick={() => void decide("hold")}>{t("proposals.hold")}</Button>
          <Button variant="danger" disabled={busy} onClick={() => void decide("reject")}>{t("proposals.reject")}</Button>
        </ButtonRow>
      ))}
      {note && <p role="alert" className="basis-full text-xs text-pretty break-words text-text-2">{note}</p>}
    </li>
  );
}
function List({ title, rows, token }: { title: string; rows: ProposalRow[]; token: string | null }) {
  if (rows.length === 0) return null;
  return (
    <Card title={title} count={rows.length}>
      <ul aria-label={title} className="flex flex-col gap-2">
        {rows.map((p) => <ProposalItem key={p.id} p={p} token={token} />)}
      </ul>
    </Card>
  );
}

/** The Proposals page: those waiting for a verdict first, then the rest, from one read. */
export function ProposalsPage() {
  const q = useApi<ProposalsView>(PROPOSALS_API.list);
  const v = q.data;
  const waiting = v?.proposals.filter((p) => p.state === "pending" || p.state === "held") ?? [];
  const others = v?.proposals.filter((p) => p.state !== "pending" && p.state !== "held") ?? [];
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("page.proposals")} description={t("proposals.intro")} />
      {q.isError ? <ErrorNote error={q.error} /> : !v ? <Loading /> : v.proposals.length === 0 ? (
        <EmptyState title={t("proposals.empty")} description={t("proposals.emptyHelp")} />
      ) : (
        <>
          <List title={t("proposals.waiting")} rows={waiting} token={v.csrf_token} />
          <List title={t("proposals.others")} rows={others} token={v.csrf_token} />
        </>
      )}
    </div>
  );
}
