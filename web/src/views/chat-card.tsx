import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { POLL_MS } from "../api.js";
import { chatTranscript, chatTurns } from "../api/generated.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { ButtonRow } from "../components/ui/button-row.js";
import { Card } from "../components/ui/card.js";
import { Clamp } from "../components/ui/clamp.js";
import { CopyIcon } from "../components/ui/copy.js";
import { DataTable } from "../components/ui/data-table.js";
import { ModalPanel } from "../components/ui/dialog.js";
import { EmptyState } from "../components/ui/notice.js";
import { ErrorNote, Loading } from "../components/ui/parts.js";
import { withoutContext } from "../../../src/shared/chat-context.js";
import { t } from "../i18n/index.js";
import { localDateTime, relativeTime } from "../lib/format.js";
import { useNow } from "./display.js";
import { StoredImages } from "./chat-images.js";

// The Runners tab's Chat Card and the reply parts the Chat page shares (design 09-dashboard-chat). It reads through the
// generated typed client (web/src/api/generated.ts) only: no fetch of its own and no route of its own.

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

/** A reply in a transcript (`copy`: ends with a Copy button for the whole reply): plain words as Clamp paragraphs; a code block or a table inside its own Card. */
function Reply({ text, copy }: { text: string; copy?: boolean }) {
  return (
    <div className="space-y-3">
      {replyParts(text).map((p, i) =>
        p.kind === "text" ? (
          <Clamp key={i} className="text-sm whitespace-pre-line">{p.text}</Clamp>
        ) : p.kind === "code" ? (
          <Card key={i} label={t("chat.code")}>
            <pre className="overflow-x-auto font-mono text-xs whitespace-pre">{p.text}</pre>
            <ButtonRow><CopyIcon value={p.text} what={t("chat.copyCode")} /></ButtonRow>
          </Card>
        ) : (
          <Card key={i} label={t("chat.table")}>
            <ReplyTable rows={p.rows} />
          </Card>
        ),
      )}
      {copy && <ButtonRow><CopyIcon value={text} what={t("chat.copyReply")} /></ButtonRow>}
    </div>
  );
}

export function ReplyTable({ rows }: { rows: string[][] }) {
  const [head = [], ...body] = rows;
  const columns = head.map((h, i) => ({ key: `c${i}`, header: h, render: (r: Record<string, string>) => r[`c${i}`] ?? "" }));
  const data = body.map((r) => Object.fromEntries(r.map((c, i) => [`c${i}`, c])));
  return <DataTable columns={columns} rows={data} rowKey={(r) => JSON.stringify(r)} label={t("chat.table")} empty={null} />;
}

/** A failed turn's reason in plain words; `detail` (chat.send's, the provider's own words) is shown with it when given. */
export function reasonWords(reason: string | null | undefined, detail?: string): string {
  const words: Record<string, () => string> = {
    withheld: () => t("chat.reason.withheld"),
    images_withheld: () => t("chat.reason.images_withheld"),
    model_error: () => (detail ? t("chat.reason.model_errorDetail", { detail }) : t("chat.reason.model_error")),
    model_refused: () => t("chat.reason.model_refused"),
    model_cut_off: () => t("chat.reason.model_cut_off"),
    too_many_steps: () => t("chat.reason.too_many_steps"),
    seq_taken: () => t("chat.reason.seq_taken"),
    error: () => (detail ? t("chat.reason.errorDetail", { detail }) : t("chat.reason.error")),
  };
  const word = words[reason ?? ""];
  return word === undefined ? t("chat.reason.other") : word();
}

export const OUTCOME_WORDS: Record<"running" | "answered" | "refused" | "failed", () => string> = {
  running: () => t("chat.outcome.running"),
  answered: () => t("chat.outcome.answered"),
  refused: () => t("chat.outcome.refused"),
  failed: () => t("chat.outcome.failed"),
};

export interface Turn { turn_id: string; session_id: string; status: "running" | "answered" | "refused" | "failed"; reason: string | null; preview?: string | null; created_at: string }

export const OUTCOME_TONE: Record<Turn["status"], string> = { running: "running", answered: "done", refused: "needs_approval", failed: "failed" };

/** A stored user message's images, as chat.transcript names them (none on any other message). */
const imagesOf = (m: Record<string, unknown>): { id: string; name: string; media_type: string }[] =>
  Array.isArray(m.images) ? (m.images as { id: string; name: string; media_type: string }[]) : [];

/** One stored turn, opened in a dialog: the question and the reply in order; no ID shows. */
function TranscriptDialog({ turn, onClose }: { turn: Turn; onClose: () => void }) {
  const q = useQuery({ queryKey: ["chat", "transcript", turn.session_id], queryFn: () => chatTranscript({ session_id: turn.session_id }) });
  const shown = (q.data?.messages ?? []).filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && (m.content !== "" || imagesOf(m).length > 0));
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
              {imagesOf(m).length > 0 && <StoredImages images={imagesOf(m)} />}
              {m.content !== "" && <Reply text={m.role === "user" ? withoutContext(String(m.content)) : String(m.content)} copy={m.role !== "user"} />}
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
        // Plain words, not the client's error: its message names the address it asked.
        <ErrorNote error={t("chat.turnsFailed")} />
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
