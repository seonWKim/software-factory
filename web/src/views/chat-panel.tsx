import { useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { API, POLL_MS, type Session, useApi } from "../api.js";
import { chatSend, chatTranscript, chatTurns, itemsList } from "../api/generated.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Card } from "../components/ui/card.js";
import { Clamp } from "../components/ui/clamp.js";
import { DataTable } from "../components/ui/data-table.js";
import { ModalPanel } from "../components/ui/dialog.js";
import { Textarea } from "../components/ui/textarea.js";
import { EmptyState, PageHeader } from "../components/ui/notice.js";
import { ErrorNote, Loading } from "../components/ui/parts.js";
import { t } from "../i18n/index.js";
import { localDateTime, relativeTime } from "../lib/format.js";
import { useNow } from "./display.js";

// The chat side panel and the Runners tab's Chat Card (design 09-dashboard-chat). Both read and write through the
// generated typed client (web/src/api/generated.ts) only: no fetch of their own and no route of their own.

/** One piece of a reply: plain words, a fenced code block (a diff) or a table. */
type Part = { kind: "text"; text: string } | { kind: "code"; text: string } | { kind: "table"; rows: string[][] };

const isTableLine = (l: string): boolean => l.trimStart().startsWith("|");
const isRule = (cells: string[]): boolean => cells.every((c) => /^:?-{2,}:?$/.test(c));
const cellsOf = (l: string): string[] => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

/** A reply split into its plain paragraphs, its ``` code blocks and its pipe tables, in order. */
export function replyParts(reply: string): Part[] {
  const parts: Part[] = [];
  let text: string[] = [];
  let table: string[][] = [];
  let code: string[] | null = null;
  const flushText = () => {
    for (const p of text.join("\n").split(/\n{2,}/)) if (p.trim() !== "") parts.push({ kind: "text", text: p.trim() });
    text = [];
  };
  const flushTable = () => {
    if (table.length > 0) parts.push({ kind: "table", rows: table });
    table = [];
  };
  for (const line of reply.split("\n")) {
    if (code !== null) {
      if (line.trimStart().startsWith("```")) {
        parts.push({ kind: "code", text: code.join("\n") });
        code = null;
      } else code.push(line);
    } else if (line.trimStart().startsWith("```")) {
      flushText();
      flushTable();
      code = [];
    } else if (isTableLine(line)) {
      flushText();
      const cells = cellsOf(line);
      if (!isRule(cells)) table.push(cells);
    } else {
      flushTable();
      text.push(line);
    }
  }
  if (code !== null) parts.push({ kind: "code", text: code.join("\n") });
  flushText();
  flushTable();
  return parts;
}

/** A reply in the panel: plain words as Clamp paragraphs; a code block or a table inside its own Card. */
function Reply({ text }: { text: string }) {
  return (
    <div className="space-y-3">
      {replyParts(text).map((p, i) =>
        p.kind === "text" ? (
          <Clamp key={i} className="text-sm whitespace-pre-line">{p.text}</Clamp>
        ) : p.kind === "code" ? (
          <Card key={i} label={t("chat.code")}>
            <pre className="overflow-x-auto font-mono text-xs whitespace-pre">{p.text}</pre>
          </Card>
        ) : (
          <Card key={i} label={t("chat.table")}>
            <ReplyTable rows={p.rows} />
          </Card>
        ),
      )}
    </div>
  );
}

function ReplyTable({ rows }: { rows: string[][] }) {
  const [head = [], ...body] = rows;
  const columns = head.map((h, i) => ({ key: `c${i}`, header: h, render: (r: Record<string, string>) => r[`c${i}`] ?? "" }));
  const data = body.map((r) => Object.fromEntries(r.map((c, i) => [`c${i}`, c])));
  return <DataTable columns={columns} rows={data} rowKey={(r) => JSON.stringify(r)} label={t("chat.table")} empty={null} />;
}

interface Said { who: "you" | "chat"; text: string }

/** The line each message starts with: the open page and, on an item page, its title, state and stage. */
function contextLine(page: string, item: { title: string | null; state_label: string; stage: string } | undefined): string {
  if (item === undefined) return t("chat.context", { page });
  return t("chat.contextItem", { page, title: item.title ?? t("chat.untitled"), state: item.state_label, stage: item.stage });
}

/** The context line a sent message starts with, taken off again where a stored message is shown. */
const withoutContext = (text: string): string => text.replace(/^Open page: [^\n]*\n\n/, "");

function reasonWords(reason: string | null | undefined): string {
  const words: Record<string, () => string> = {
    withheld: () => t("chat.reason.withheld"),
    model_error: () => t("chat.reason.model_error"),
    too_many_steps: () => t("chat.reason.too_many_steps"),
    seq_taken: () => t("chat.reason.seq_taken"),
    error: () => t("chat.reason.error"),
  };
  const word = words[reason ?? ""];
  return word === undefined ? t("chat.reason.other") : word();
}

const OUTCOME_WORDS: Record<"running" | "answered" | "refused" | "failed", () => string> = {
  running: () => t("chat.outcome.running"),
  answered: () => t("chat.outcome.answered"),
  refused: () => t("chat.outcome.refused"),
  failed: () => t("chat.outcome.failed"),
};

/**
 * The chat side panel (design 09-dashboard-chat): beside the page, which stays visible. Kept mounted while closed, so the
 * conversation survives closing it. Each message carries the open page and item; the panel only answers.
 */
export function ChatPanel({ open, onClose, page, itemId }: { open: boolean; onClose: () => void; page: string; itemId: string | null }) {
  const client = useQueryClient();
  const session = useApi<Session>(API.session, false);
  const [said, setSaid] = useState<Said[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [sessionId, setSessionId] = useState<string | undefined>();
  const token = session.data?.csrf_token;
  if (!open) return null;

  const send = async () => {
    const message = text.trim();
    if (message === "" || token === undefined || busy) return;
    setBusy(true);
    setSaid((s) => [...s, { who: "you", text: message }]);
    setText("");
    try {
      // The open item's title, state and stage come from the stored items list, so the model can answer "What is this?".
      const list = itemId === null ? null : await client.fetchQuery({ queryKey: ["chat", "items"], queryFn: () => itemsList({}), staleTime: 10_000 });
      const item = list?.items.find((i) => i.id === itemId);
      const res = await chatSend(token, { ...(sessionId === undefined ? {} : { session_id: sessionId }), text: `${contextLine(page, item)}\n\n${message}` });
      if (res.status === 503) setSaid((s) => [...s, { who: "chat", text: t("chat.off") }]);
      else if (!res.ok) setSaid((s) => [...s, { who: "chat", text: t("chat.sendFailed", { reason: res.value.error ?? "" }).trim() }]);
      else {
        setSessionId(res.value.session_id);
        const reply = res.value.outcome === "answered" && res.value.reply !== undefined ? res.value.reply : t("chat.noReply", { reason: reasonWords(res.value.reason) });
        setSaid((s) => [...s, { who: "chat", text: reply }]);
      }
    } catch {
      setSaid((s) => [...s, { who: "chat", text: t("chat.failedRead") }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside aria-label={t("chat.title")} data-chat-panel className="w-96 shrink-0 overflow-y-auto border-l border-border bg-bg p-4 max-lg:fixed max-lg:inset-y-0 max-lg:right-0 max-lg:z-30 max-lg:w-80 max-lg:max-w-full max-lg:shadow-lg">
      <PageHeader
        width="read"
        title={t("chat.title")}
        description={t("chat.description")}
        actions={
          <Button variant="ghost" size="icon" aria-label={t("chat.close")} onClick={onClose}>
            <X aria-hidden className="size-4" />
          </Button>
        }
      />
      <Card title={t("chat.card")}>
        <div className="space-y-4">
        <ul aria-label={t("chat.card")} aria-live="polite" className="space-y-3">
          {said.length === 0 && <li className="text-sm text-text-2">{t("chat.empty")}</li>}
          {said.map((m, i) => (
            <li key={i} data-from={m.who}>
              <span className="text-xs font-medium text-text-2">{m.who === "you" ? t("chat.you") : t("chat.reply")}</span>
              {m.who === "you" ? <Clamp className="text-sm whitespace-pre-line">{m.text}</Clamp> : <Reply text={m.text} />}
            </li>
          ))}
        </ul>
        <div className="space-y-2">
          <Textarea
            aria-label={t("chat.field")}
            placeholder={t("chat.placeholder")}
            rows={3}
            className="w-full"
            value={text}
            disabled={busy}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
            }}
          />
          <Button variant="primary" disabled={busy || text.trim() === "" || token === undefined} onClick={() => void send()}>
            {busy ? t("chat.sending") : t("chat.send")}
          </Button>
        </div>
        </div>
      </Card>
    </aside>
  );
}

interface Turn { turn_id: string; session_id: string; status: "running" | "answered" | "refused" | "failed"; reason: string | null; created_at: string }

const OUTCOME_TONE: Record<Turn["status"], string> = { running: "running", answered: "done", refused: "needs_approval", failed: "failed" };

/** One stored turn, opened in a dialog: the question and the reply in order; no ID shows. */
function TranscriptDialog({ turn, onClose }: { turn: Turn; onClose: () => void }) {
  const q = useQuery({ queryKey: ["chat", "transcript", turn.session_id], queryFn: () => chatTranscript({ session_id: turn.session_id }) });
  const shown = (q.data?.messages ?? []).filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content !== "");
  return (
    <ModalPanel title={t("chat.transcriptTitle")} onClose={onClose}>
      <div className="space-y-3">
      <p className="text-xs text-text-2">{t("chat.transcriptFor", { when: localDateTime(turn.created_at) })}</p>
      {q.isError ? (
        <ErrorNote error={q.error} />
      ) : !q.data ? (
        <Loading rows={2} label="loading.transcript" onRetry={() => void q.refetch()} />
      ) : shown.length === 0 ? (
        <EmptyState title={t("chat.transcriptEmpty")} />
      ) : (
        <ul className="space-y-3">
          {shown.map((m, i) => (
            <li key={i}>
              <span className="text-xs font-medium text-text-2">{m.role === "user" ? t("chat.you") : t("chat.reply")}</span>
              <Reply text={m.role === "user" ? withoutContext(String(m.content)) : String(m.content)} />
            </li>
          ))}
        </ul>
      )}
      </div>
    </ModalPanel>
  );
}

/**
 * The Runners tab's Chat Card (design 09-dashboard-chat, patterns.md "Autonomous work is visible"): what the chat is
 * answering now, its recent turns with outcome and reason, and a Transcript button for each, opened in a dialog.
 */
export function ChatCard(): ReactNode {
  const now = useNow();
  const [open, setOpen] = useState<Turn | null>(null);
  const q = useQuery({ queryKey: ["chat", "turns"], queryFn: () => chatTurns({ limit: 10 }), refetchInterval: POLL_MS, refetchIntervalInBackground: false });
  const turns = (q.data?.turns ?? []) as unknown as Turn[];
  const running = turns.filter((x) => x.status === "running").length;
  return (
    <Card title={t("chat.runnersTitle")} count={q.data ? turns.length : undefined}>
      {q.isError ? (
        <ErrorNote error={q.error} />
      ) : !q.data ? (
        <Loading rows={2} label="loading.running" onRetry={() => void q.refetch()} />
      ) : (
        <div className="space-y-4">
          <p data-testid="chat-activity" className="text-sm">
            {running === 0 ? t("chat.activityNone") : running === 1 ? t("chat.activityOne") : t("chat.activityMany", { count: running })}
          </p>
          <DataTable
            label={t("chat.turns")}
            rows={turns}
            rowKey={(x) => x.turn_id}
            empty={<EmptyState title={t("chat.turnsNone")} description={t("chat.turnsNoneBody")} />}
            columns={[
              { key: "when", header: t("chat.colWhen"), render: (x) => <span title={localDateTime(x.created_at)}>{relativeTime(x.created_at, now)}</span> },
              { key: "outcome", header: t("chat.colOutcome"), render: (x) => <Badge level={OUTCOME_TONE[x.status]}>{OUTCOME_WORDS[x.status]()}</Badge> },
              { key: "reason", header: t("chat.colReason"), render: (x) => (x.reason === null ? "" : reasonWords(x.reason)) },
              {
                key: "transcript",
                header: t("chat.colTranscript"),
                render: (x) => (
                  <Button variant="ghost" size="sm" onClick={() => setOpen(x)}>
                    {t("chat.transcript")}
                  </Button>
                ),
              },
            ]}
          />
        </div>
      )}
      {open !== null && <TranscriptDialog turn={open} onClose={() => setOpen(null)} />}
    </Card>
  );
}
