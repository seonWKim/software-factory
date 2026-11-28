import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { type ChatCommandInput, type ChatDecisionOutput, chatCommand, chatDecision, chatMode } from "../api/generated.js";
import { type ItemCommand, plainRefusal } from "../api/item-commands.js";
import type { Why } from "../api/items.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { ButtonRow } from "../components/ui/button-row.js";
import { Clamp } from "../components/ui/clamp.js";
import { Markdown } from "../components/ui/markdown.js";
import { Notice } from "../components/ui/notice.js";
import { Textarea } from "../components/ui/textarea.js";
import { type MessageKey } from "../i18n/en.js";
import { t } from "../i18n/index.js";
import { whyText } from "../lib/format.js";
import { type Outcome, OutcomeText } from "./command-box.js";
import { primaryOf } from "./item-commands.js";
import { commandLabel } from "./item-decisions.js";
import { summaryOf } from "./thread.js";

// A Needs-you decision in the chat (design 09-dashboard-chat, 04-chat-commands): the decision of the item the chat is
// opened on (?item=), read through chat.decision and sent through chat.command, the item commands route's own path
// (itemCommandSend), so a button here changes the item exactly as the item page's button and the typed command do.
// It reads top to bottom as the question (the why sentence, Markdown), the evidence (In short and the newest factory
// message, each in a Clamp), one row of buttons (the recommendation first, the one primary), a reply box whose words
// are sent as a sentence the controller reads into pending proposals, and those proposals with Confirm all and Cancel.
// No item or proposal ID is shown. The verdict's Good, Bad and Feedback stay on the item page.

/** The commands whose note is the reply box's words: the reason or the feedback (src/ui/commands.ts NEEDS_TEXT). */
const WITH_NOTE: readonly string[] = ["reject", "revise"];

/** The decision's query key: a send refetches it, so the buttons and proposals follow the item. */
export const decisionKey = (item: string) => ["chat", "decision", item] as const;

/** The stored permission mode in a Badge (decision 2: above the conversation), read through chat.mode. */
export function ModeBadge() {
  const mode = useQuery({ queryKey: ["chat", "mode"], queryFn: () => chatMode({}), staleTime: 30_000 }).data?.mode;
  if (mode === undefined) return null;
  const key = `chat.mode.${mode}`;
  return (
    <span data-chat-mode={mode} className="inline-flex min-w-0 items-center gap-2 text-xs text-text-2">
      <span>{t("chat.mode")}</span>
      <Badge>{key in MODE_WORDS ? t(key as MessageKey) : mode}</Badge>
    </span>
  );
}

/** The mode words en/chat.ts has; an unknown mode shows as stored. */
const MODE_WORDS: Readonly<Record<string, true>> = { "chat.mode.ask_all": true, "chat.mode.ask_irreversible": true, "chat.mode.full": true };

/** What chat.command answered, in the decision's words: a refusal (Notice) or the result line (OutcomeText). */
type Result = { refusal: string } | { outcome: Outcome };

/** The result of one answer: refused (status or outcome), else applied, or sent for the controller. */
export function resultOf(res: { ok: boolean; status: number; value: { error?: string; outcome?: string; refusal?: string | null } }): Result {
  if (!res.ok) return { refusal: res.status === 503 ? t("chat.decisionOff") : plainRefusal(res.value.error ?? "") };
  if (res.value.outcome === "refused") return { refusal: plainRefusal(res.value.refusal ?? "") };
  return { outcome: { tone: "status", text: res.value.outcome === "applied" || res.value.outcome === "already_done" ? t("chat.decisionApplied") : t("commands.sent") } };
}

/** The decision of `item` while the owner is next; nothing for any other item. */
export function ChatDecision({ item, token }: { item: string; token: string | undefined }) {
  const client = useQueryClient();
  const { data } = useQuery({ queryKey: decisionKey(item), queryFn: () => chatDecision({ item }), retry: false });
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const field = useId();
  if (!data?.waiting) return null;

  const send = async (input: Omit<ChatCommandInput, "item">, clear = false) => {
    if (token === undefined || busy) return;
    setBusy(true);
    try {
      const r = resultOf(await chatCommand(token, { item, ...input }));
      setResult(r);
      if (clear && "outcome" in r) setReply("");
    } catch {
      setResult({ refusal: t("chat.decisionFailed") });
    } finally {
      setBusy(false);
      await client.invalidateQueries({ queryKey: decisionKey(item) });
    }
  };

  const commands = (data.commands as unknown as ItemCommand[]).filter((c) => c.name !== "verdict");
  const primary = primaryOf(commands);
  const ordered = primary ? [primary, ...commands.filter((c) => c !== primary)] : commands;
  const blocked = commands.find((c) => !c.allowed && c.reason);
  const text = reply.trim();
  return (
    <section data-chat-decision aria-label={t("chat.decision")} className="mt-2 min-w-0 space-y-3 rounded-box border border-border-strong p-4">
      {data.title ? <p className="text-xs text-text-2 break-words">{data.title}</p> : null}
      <div data-decision-question className="min-w-0 break-words">
        <Markdown text={whyText(data.why as unknown as Why)} />
      </div>
      <Evidence data={data} />
      {ordered.length > 0 ? (
        <ButtonRow data-decision-actions>
          {ordered.map((c) => (
            <Button
              key={c.name}
              variant={c === primary ? "primary" : "secondary"}
              data-action={c.name}
              {...(c === primary && { "data-recommended": "" })}
              disabled={!c.allowed || busy || token === undefined}
              onClick={() => void send(WITH_NOTE.includes(c.name) && text !== "" ? { command: c.name, note: text } : { command: c.name }, WITH_NOTE.includes(c.name))}
            >
              {commandLabel(c.name)}
            </Button>
          ))}
        </ButtonRow>
      ) : null}
      {blocked ? <OutcomeText outcome={{ tone: "status", text: plainRefusal(blocked.reason ?? "") }} /> : null}
      <div className="space-y-2">
        <label htmlFor={field} className="text-xs text-text-2">{t("chat.decisionReply")}</label>
        <Textarea id={field} rows={2} value={reply} onChange={(e) => setReply(e.target.value)} className="w-full" />
        <ButtonRow>
          <Button data-action="sentence" disabled={text === "" || busy || token === undefined} onClick={() => void send({ command: "sentence", note: text }, true)}>
            {t("chat.decisionSendReply")}
          </Button>
        </ButtonRow>
      </div>
      {data.proposals.length > 0 ? (
        <ul aria-label={t("command.proposals")} className="space-y-2">
          {data.proposals.map((p, n) => (
            <li key={p.id} data-chat-proposal={n} className="min-w-0 rounded-control border border-border-strong p-2">
              <p className="text-xs text-text-1">{t("command.pending")}</p>
              <ul className="my-1 space-y-0.5">
                {p.lines.map((l) => <li key={l} className="min-w-0 text-sm break-words"><code className="break-all">{l}</code></li>)}
              </ul>
              <ButtonRow>
                <Button variant="ghost" data-action="proposal_cancel" disabled={busy || token === undefined} onClick={() => void send({ command: "proposal_cancel", proposal: p.id })}>{t("common.cancel")}</Button>
                <Button data-action="proposal_confirm" disabled={busy || token === undefined} onClick={() => void send({ command: "proposal_confirm", proposal: p.id })}>{t("command.confirmAll")}</Button>
              </ButtonRow>
            </li>
          ))}
        </ul>
      ) : null}
      {result && "refusal" in result ? <Notice tone="bad">{result.refusal}</Notice> : null}
      {result && "outcome" in result ? <div data-decision-result><OutcomeText outcome={result.outcome} /></div> : null}
    </section>
  );
}

/** The evidence: In short, then the newest factory message's summary, each clamped. */
function Evidence({ data }: { data: ChatDecisionOutput }) {
  if (!data.in_short && !data.evidence) return null;
  return (
    <div data-decision-evidence className="min-w-0 space-y-1 text-sm text-pretty text-text-1">
      {data.in_short ? <Clamp className="break-words">{data.in_short}</Clamp> : null}
      {data.evidence ? <Clamp className="break-words">{summaryOf(data.evidence)}</Clamp> : null}
    </div>
  );
}
