import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { API, type RuleRow, type RuleVerdict, type RulesView, postRuleVerdict, useApi } from "../api.js";
import { Button } from "../components/ui/button.js";
import { ButtonRow } from "../components/ui/button-row.js";
import { Dialog, announceStatus } from "../components/ui/dialog.js";
import { Field } from "../components/ui/field.js";
import { Badge, Empty, ErrorNote, Loading, Section } from "../components/ui/parts.js";
import { Textarea } from "../components/ui/textarea.js";

// The Rules page (design 09-dashboard-app.md and 07-self-improvement.md, issue #571): the owner's tacit ledger entries
// waiting for a verdict (pending pushbacks, candidate classes, structure proposals), each with its evidence lines and
// rule draft, read through GET /api/v1/rules. Promote, Hold and Reject each open a dialog that asks for a reason before
// it sends; Promote also lets the owner edit the rule's wording, sent beside the kept draft. Only the owner sends; anyone
// else sees the list with the reason. With the tacit plugin `none` the page shows one action: how to turn the ledger on.
// One card per entry at every width, so no table turns into cards.

const muted = "text-xs text-pretty text-text-2";

const KIND_LABEL: Record<string, string> = { pushback: "Pushback", class: "Candidate class", structure: "Structure proposal" };
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

/** The verdict dialog: a reason first, and for promote the rule's wording, prefilled with the draft. */
function VerdictDialog({ entry, verdict, token, onClose }: { entry: RuleRow; verdict: RuleVerdict; token: string; onClose: () => void }) {
  const client = useQueryClient();
  const [reason, setReason] = useState("");
  const [text, setText] = useState(entry.rule_draft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const promote = verdict === "promote";
  const wording = text.trim();
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      // The wording goes only when the owner changed it; the ledger keeps the draft either way.
      const edited = promote && wording !== entry.rule_draft.trim();
      const r = await postRuleVerdict(token, { id: entry.id, verdict, reason: reason.trim(), ...(edited ? { text: wording } : {}) });
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
        <Field label="Rule wording" htmlFor={`${entry.id}-wording`} help="Edit it before promoting if you like; the ledger keeps its own draft beside your wording.">
          <Textarea id={`${entry.id}-wording`} aria-label="Rule wording" className="min-h-20" value={text} maxLength={2000} onChange={(e) => setText(e.target.value)} />
        </Field>
      )}
      <Field label="Why?" htmlFor={`${entry.id}-reason`}>
        <Textarea id={`${entry.id}-reason`} aria-label="Reason" className="min-h-16" value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </Dialog>
  );
}

function RuleCard({ entry, token }: { entry: RuleRow; token: string | null }) {
  const [open, setOpen] = useState<RuleVerdict | null>(null);
  return (
    <li data-rule={entry.id} className="space-y-2 p-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <Badge>{KIND_LABEL[entry.kind] ?? entry.kind}</Badge>
        <span className="min-w-0 font-mono text-xs break-all text-text-2">{entry.id}</span>
        {entry.scope.length > 0 && <span className={muted}>for {entry.scope.join(", ")}</span>}
      </div>
      <div>
        <h3 className="text-xs font-medium text-text-2">Rule draft</h3>
        <p data-rule-draft className="text-sm text-pretty break-words whitespace-pre-wrap">
          {entry.rule_draft === "" ? <span className="text-text-3">No draft yet: the ledger has not distilled one.</span> : entry.rule_draft}
        </p>
      </div>
      <div>
        <h3 className="text-xs font-medium text-text-2">Evidence</h3>
        {entry.evidence.length === 0 ? (
          <p className={muted}>None recorded.</p>
        ) : (
          <ul aria-label={`Evidence for ${entry.id}`} className="list-disc space-y-0.5 pl-5 text-sm">
            {entry.evidence.map((line, i) => (
              <li key={i} className="text-pretty break-words">
                {line}
              </li>
            ))}
          </ul>
        )}
      </div>
      {token !== null && (
        <ButtonRow className="pt-1">
          {VERDICTS.map((v) => (
            <Button key={v.verdict} variant={v.verdict === "reject" ? "danger" : "secondary"} onClick={() => setOpen(v.verdict)}>
              {v.label}
            </Button>
          ))}
        </ButtonRow>
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
      <Button variant="secondary" aria-expanded={shown} aria-controls="rules-enable" onClick={() => setShown(!shown)}>
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
        A promoted rule reaches every run's prompt under Learned rules, unless its scope names another domain. The ledger lives in your
        agents home; this page only reads it and sends your verdicts.
      </p>
    </Section>
  );
}
