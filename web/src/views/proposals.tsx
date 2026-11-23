import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useApi } from "../api.js";
import { PROPOSALS_API, type ProposalEvidence, type ProposalRow, type ProposalVerdict, type ProposalsView, postProposalVerdict } from "../api/proposals.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { ButtonRow } from "../components/ui/button-row.js";
import { Card } from "../components/ui/card.js";
import { Dialog } from "../components/ui/dialog.js";
import { Disclosure } from "../components/ui/disclosure.js";
import { KeyValue, ValueBlock } from "../components/ui/key-value.js";
import { ListRow, ROW_TITLE } from "../components/ui/list-row.js";
import { OverflowMenu } from "../components/ui/menu.js";
import { EmptyState, PageHeader } from "../components/ui/notice.js";
import { ErrorNote, Loading } from "../components/ui/parts.js";
import type { MessageKey } from "../i18n/en.js";
import { t } from "../i18n/index.js";
import { errorLabel, localDateTime, relativeTime } from "../lib/format.js";

// The Proposals page (design 09-dashboard-proposals, issue #496): the improve run's suggested changes to an entity file,
// each with its golden evidence (catch and false-alarm rates before and after, the cases replayed) and the change behind
// "Show the change". Each is a ListRow; a waiting or held one shows Promote and has Promote, Hold (not once held) and
// Reject in its "⋯" menu. Promote and Reject cannot be undone, so each asks first in a Dialog; the verdict is
// POST /api/v1/proposals/verdict with the CSRF token, and nothing changes before it. A refused send shows in the dialog.

const muted = "text-xs text-pretty text-text-2";
/** A row's padding: tighter on a phone, as the Rules page's rows. */
const ROW_PAD = "max-sm:p-2";
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

/** The verdicts that cannot be undone, each asked first in a Dialog: what confirming does, and its button. */
const CONFIRM: Readonly<Record<"promote" | "reject", { title: MessageKey; consequence: MessageKey; label: MessageKey }>> = {
  promote: { title: "proposals.confirmPromote", consequence: "proposals.consequencePromote", label: "proposals.promote" },
  reject: { title: "proposals.confirmReject", consequence: "proposals.consequenceReject", label: "proposals.reject" },
};

function ProposalItem({ p, token }: { p: ProposalRow; token: string | null }) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [asking, setAsking] = useState<"promote" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const menu = useRef<HTMLDivElement>(null);
  const promote = useRef<HTMLButtonElement>(null);
  // Where the dialog started: Promote's own button, or the ⋯ button when a menu item opened it (the item is gone when the menu closes).
  const [from, setFrom] = useState<"button" | "menu">("menu");
  const returnFocusTo = { get current() { return from === "button" ? promote.current : (menu.current?.querySelector<HTMLElement>("button[aria-haspopup]") ?? null); } };
  /** Sends the verdict; true when it was taken (or answered unchanged), false with the error shown where it was asked. */
  const decide = async (verdict: ProposalVerdict, show: (message: string) => void): Promise<boolean> => {
    if (token === null) return false;
    setBusy(true);
    setNote(null);
    try {
      const r = await postProposalVerdict(token, { id: p.id, verdict });
      if (!r.ok) {
        show(r.error);
        return false;
      }
      if (r.unchanged) setNote(t("proposals.unchanged"));
      await client.invalidateQueries({ queryKey: [PROPOSALS_API.list] });
      return true;
    } catch (err) {
      show(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const ask = (verdict: "promote" | "reject", origin: "button" | "menu") => {
    setFrom(origin);
    setError(null);
    setAsking(verdict);
  };
  const open = p.state === "pending" || p.state === "held";
  const decides = open && token !== null;
  const line = stateLine(p);
  const title = t("proposals.title", { file: p.file, failure: errorLabel(p.error_code), count: p.run_count });
  return (
    <ListRow
      data-proposal={p.id}
      className={ROW_PAD}
      title={<p className={`${ROW_TITLE} font-medium`} title={title}>{title}</p>}
      details={
        <>
          <Badge level={LEVEL[p.state]}>{STATES[p.state] ? t(STATES[p.state]!) : p.state}</Badge>
          <span title={localDateTime(p.created_at)}>{t("proposals.when", { when: relativeTime(p.created_at, Date.now()) })}</span>
        </>
      }
      menu={
        decides && (
          <div ref={menu}>
            <OverflowMenu
              label={t("proposals.actions", { title })}
              items={[
                { label: t("proposals.promote"), action: "promote", disabled: busy, onSelect: () => ask("promote", "menu") },
                // Hold applies only to a waiting proposal: a held one does not show it.
                ...(p.state === "held" ? [] : [{ label: t("proposals.hold"), action: "hold", disabled: busy, onSelect: () => void decide("hold", setNote) }]),
                { label: t("proposals.reject"), action: "reject", danger: true, disabled: busy, onSelect: () => ask("reject", "menu") },
              ]}
            />
          </div>
        )
      }
    >
      {line && <p className={muted}>{line}</p>}
      {p.why && <p className="text-sm text-pretty">{`${t("proposals.why")}: ${p.why}`}</p>}
      {p.before && p.after && <Evidence before={p.before} after={p.after} />}
      {p.diff && (
        <Disclosure summary={t("proposals.showChange")}>
          <ValueBlock>{p.diff}</ValueBlock>
        </Disclosure>
      )}
      {open && p.needs_human_merge && <p className={muted}>{t("proposals.humanMerge")}</p>}
      {open && token === null && <p className={muted}>{t("proposals.noDecide")}</p>}
      {decides && (
        <ButtonRow>
          <Button ref={promote} size="sm" disabled={busy} onClick={() => ask("promote", "button")}>{t("proposals.promote")}</Button>
        </ButtonRow>
      )}
      {note && <p role="alert" className="text-xs text-pretty break-words text-text-2">{note}</p>}
      {asking !== null && (
        <Dialog
          title={t(CONFIRM[asking].title, { title })}
          consequence={t(CONFIRM[asking].consequence)}
          confirmLabel={t(CONFIRM[asking].label)}
          confirmDisabled={busy}
          danger={asking === "reject"}
          error={error}
          onConfirm={() => void decide(asking, setError).then((done) => done && setAsking(null))}
          onClose={() => setAsking(null)}
          returnFocusTo={returnFocusTo}
        />
      )}
    </ListRow>
  );
}
function List({ title, rows, token }: { title: string; rows: ProposalRow[]; token: string | null }) {
  if (rows.length === 0) return null;
  return (
    <Card title={title} count={rows.length}>
      <ul aria-label={title} className="divide-y divide-border rounded-control border border-border">
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
  // A plain block: PageHeader's bottom margin and each Card's top margin collapse to one 24 px gap (a flex gap would add them).
  return (
    <div>
      <PageHeader title={t("page.proposals")} description={t("proposals.intro")} />
      {q.isError ? <ErrorNote error={q.error} /> : !v ? <Loading label="loading.proposals" onRetry={() => void q.refetch()} /> : v.proposals.length === 0 ? (
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
