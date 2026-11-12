import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { API, type RuleRow, type RuleVerdict, type RulesView, postRuleVerdict, useApi } from "../api.js";
import { Button } from "../components/ui/button.js";
import { Dialog, announceStatus } from "../components/ui/dialog.js";
import { Badge, Empty, ErrorNote, Loading, Section } from "../components/ui/parts.js";
import { field } from "./item-decisions.js";

// The Rules page (design 09-dashboard-app.md and 07-self-improvement.md, issue #571): the owner's tacit ledger entries
// waiting for a verdict (candidate classes `C-…` and structure proposals `P-…`), each with its title, state and ID, read
// through GET /api/v1/rules. Promote, Hold and Reject each open a dialog that asks for a reason before it sends; Promote
// of a class also asks for the rule's wording, sent as the rule (a proposal takes none). Only the owner sends; anyone
// else sees the list with the reason. With the tacit plugin `none` the page shows one action: how to turn the ledger on.
// One card per entry at every width, so no table turns into cards.

const muted = "text-xs text-pretty text-text-2";
const BUTTON = "h-8 w-auto px-2";

const STATE_LABEL: Record<string, string> = { open: "Open", pending: "Pending", held: "Held" };
/** A candidate class (`C-…`) takes the owner's wording as its rule on promote; a structure proposal takes none. */
const isClass = (id: string): boolean => id.startsWith("C-");
const VERDICTS: readonly { verdict: RuleVerdict; label: string }[] = [
  { verdict: "promote", label: "Promote" },
  { verdict: "hold", label: "Hold" },
  { verdict: "reject", label: "Reject" },
];
const CONSEQUENCE: Record<RuleVerdict, string> = {
  promote: "Promoting makes this rule part of every run's prompt from the next run on.",
  hold: "Holding keeps the entry in the ledger without a decision.",
  reject: "Rejecting drops the entry: it never reaches a prompt.",
};

/** The verdict dialog: a reason first, and for promote of a class the rule's wording, prefilled with its title. */
function VerdictDialog({ entry, verdict, token, onClose }: { entry: RuleRow; verdict: RuleVerdict; token: string; onClose: () => void }) {
  const client = useQueryClient();
  const [reason, setReason] = useState("");
  const [text, setText] = useState(entry.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const promote = verdict === "promote" && isClass(entry.id);
  const wording = text.trim();
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await postRuleVerdict(token, { id: entry.id, verdict, reason: reason.trim(), ...(promote ? { text: wording } : {}) });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      announceStatus(`${VERDICTS.find((v) => v.verdict === verdict)!.label} sent for ${entry.id}.`);
      await client.invalidateQueries({ queryKey: [API.rules] });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const label = VERDICTS.find((v) => v.verdict === verdict)!.label;
  return (
    <Dialog
      title={`${label} ${entry.id}`}
      consequence={CONSEQUENCE[verdict]}
      confirmLabel={`Send ${label.toLowerCase()}`}
      confirmDisabled={busy || reason.trim() === "" || (promote && wording === "")}
      danger={verdict === "reject"}
      error={error}
      onConfirm={() => void send()}
      onClose={onClose}
    >
      {promote && (
        <label className="flex flex-col gap-1 text-sm font-medium">
          Rule wording
          <textarea aria-label="Rule wording" className={`${field} min-h-20 font-normal`} value={text} maxLength={2000} onChange={(e) => setText(e.target.value)} />
          <span className={muted}>The ledger stores this wording as the promoted rule.</span>
        </label>
      )}
      <label className="flex flex-col gap-1 text-sm font-medium">
        Why?
        <textarea aria-label="Reason" className={`${field} min-h-16 font-normal`} value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} />
      </label>
    </Dialog>
  );
}

function RuleCard({ entry, token }: { entry: RuleRow; token: string | null }) {
  const [open, setOpen] = useState<RuleVerdict | null>(null);
  return (
    <li data-rule={entry.id} className="space-y-2 p-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <Badge>{STATE_LABEL[entry.state] ?? entry.state}</Badge>
        <span className="min-w-0 font-mono text-xs break-all text-text-2">{entry.id}</span>
      </div>
      <p data-rule-title className="text-sm text-pretty break-words whitespace-pre-wrap">
        {entry.title}
      </p>
      {token !== null && (
        <div className="flex flex-wrap gap-2">
          {VERDICTS.map((v) => (
            <Button key={v.verdict} variant="outline" className={BUTTON} onClick={() => setOpen(v.verdict)}>
              {v.label}
            </Button>
          ))}
        </div>
      )}
      {open !== null && token !== null && <VerdictDialog entry={entry} verdict={open} token={token} onClose={() => setOpen(null)} />}
    </li>
  );
}

/** The `none` plugin's empty state: one action, which shows how to turn the ledger on. */
function LedgerOff() {
  const [shown, setShown] = useState(false);
  return (
    <div className="space-y-2">
      <Empty>No tacit ledger is on, so there are no rules to review.</Empty>
      <Button variant="outline" className={BUTTON} aria-expanded={shown} aria-controls="rules-enable" onClick={() => setShown(!shown)}>
        How to turn on the ledger
      </Button>
      {shown && (
        <ol id="rules-enable" className="list-decimal space-y-1 pl-5 text-sm text-pretty break-words">
          <li>
            In factory.config.json set <code className="font-mono break-all">"plugins": {"{"} "tacit": "agents-home" {"}"}</code>.
          </li>
          <li>
            Check that your agents home has <code className="font-mono break-all">bin/tacit</code> and{" "}
            <code className="font-mono break-all">bin/evolve</code>: the home is AGENTS_HOME when set, else ~/.agents.
          </li>
          <li>Restart the factory and `factory ui`. Delete the key to turn it off again.</li>
        </ol>
      )}
    </div>
  );
}

export function RulesPage() {
  const rules = useApi<RulesView>(API.rules);
  const v = rules.data;
  if (rules.isError) return <ErrorNote error={rules.error} />;
  if (!v) return <Loading rows={3} />;
  if (!v.enabled) {
    return (
      <Section title="Rules">
        <LedgerOff />
      </Section>
    );
  }
  const token = v.judge === null ? v.csrf_token : null;
  return (
    <Section title="Rules waiting for you" count={v.entries.length}>
      {v.judge !== null && (
        <p role="note" className="mb-2 rounded-control bg-pill-warn-bg px-3 py-2 text-sm text-pretty break-words text-pill-warn-fg">
          Read-only: {v.judge}
        </p>
      )}
      {v.error !== null && (
        <p role="alert" className="mb-2 text-sm text-pretty break-words text-pill-bad-fg">
          {v.error}
        </p>
      )}
      {v.entries.length === 0 ? (
        v.error === null && <Empty>Nothing waits for a verdict: new pushbacks show here once the ledger has them.</Empty>
      ) : (
        <ul aria-label="Rules waiting for you" className="divide-y divide-border rounded-control border border-border">
          {v.entries.map((e) => (
            <RuleCard key={e.id} entry={e} token={token} />
          ))}
        </ul>
      )}
      <p className={`mt-3 ${muted}`}>
        A promoted rule reaches every run's prompt under Learned rules, with its exceptions and scope. The ledger lives in your agents
        home; this page only reads it and sends your verdicts.
      </p>
    </Section>
  );
}
