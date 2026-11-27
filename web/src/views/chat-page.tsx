import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp } from "lucide-react";
import { Fragment, type KeyboardEvent, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { API, type Session, useApi } from "../api.js";
import { chatSend, itemsList } from "../api/generated.js";
import { Button } from "../components/ui/button.js";
import { Markdown } from "../components/ui/markdown.js";
import { PageHeader } from "../components/ui/notice.js";
import { Textarea } from "../components/ui/textarea.js";
import { type MessageKey } from "../i18n/en.js";
import { t } from "../i18n/index.js";
import { cn } from "../lib/cn.js";
import { ReplyTable, reasonWords, replyParts } from "./chat-card.js";

// The Chat page (design 09-dashboard-chat): one centred column, the conversation above and the composer pinned under
// it. It reads and writes through the generated typed client (web/src/api/generated.ts) only.

/** One message: yours (with the error of its send, if it failed) or the chat's reply. */
type Said = { id: number; who: "you"; text: string; error?: string } | { id: number; who: "chat"; text: string };

interface Conversation {
  said: Said[];
  sessionId?: string;
  /** The send on its way: its AbortController (Stop) and when it started (the elapsed line). */
  pending?: { controller: AbortController; startedAt: number } | undefined;
}

const EMPTY: Conversation = { said: [] };
// Kept in the query cache, not in the page: going to another page and back keeps the conversation and its session, and a
// send that finishes while the page is away still lands. A reload starts a new conversation.
const KEY = ["chat", "conversation"] as const;

/** The example questions of the empty page; one click puts the question in the composer. */
const EXAMPLES: readonly MessageKey[] = ["chat.example.needs", "chat.example.working", "chat.example.failed", "chat.example.cost"];

/** The composer grows from one line up to this many, then scrolls. */
const MAX_LINES = 8;

/** Within this many pixels of the end, the column counts as read to the end and follows new messages. */
const NEAR_END = 80;

/** A reply as readable markdown: paragraphs, lists and code blocks in Markdown, a pipe table as a DataTable. */
function ChatReply({ text }: { text: string }) {
  const groups: ({ kind: "md"; text: string } | { kind: "table"; rows: string[][] })[] = [];
  for (const p of replyParts(text)) {
    if (p.kind === "table") {
      groups.push({ kind: "table", rows: p.rows });
      continue;
    }
    const md = p.kind === "code" ? `\`\`\`\n${p.text}\n\`\`\`` : p.text;
    const last = groups.at(-1);
    if (last?.kind === "md") last.text += `\n\n${md}`;
    else groups.push({ kind: "md", text: md });
  }
  return (
    <div className="min-w-0 space-y-3">
      {groups.map((g, i) => (g.kind === "md" ? <Markdown key={i} text={g.text} /> : <ReplyTable key={i} rows={g.rows} />))}
    </div>
  );
}

/** Each dot of the answering mark pulses a little after the one before it. */
const DOT_DELAYS = ["[animation-delay:0ms]", "[animation-delay:200ms]", "[animation-delay:400ms]"] as const;

/** Three dots in the reply's place while the chat answers; screen readers hear "Answering…". */
function Answering() {
  return (
    <div role="status" data-answering className="flex h-6 items-center gap-1">
      <span className="sr-only">{t("chat.answering")}</span>
      {DOT_DELAYS.map((delay) => (
        <span key={delay} aria-hidden className={cn("size-1.5 rounded-pill bg-text-3 motion-safe:animate-pulse", delay)} />
      ))}
    </div>
  );
}

/** Seconds of waiting before the elapsed count shows. */
const ELAPSED_AFTER_S = 5;

/** Beside Stop: "Answering…", and from 5 s on "Answering… N s", counted once a second. Plain text, no live role. */
function Elapsed({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  return <p className="text-sm text-text-2">{seconds < ELAPSED_AFTER_S ? t("chat.answering") : t("chat.sendingFor", { seconds })}</p>;
}

/** The item a message is about (`/app/chat?item=<id>`), or null. */
const itemOf = (): string | null => new URLSearchParams(location.search).get("item");

/**
 * The Chat page (design 09-dashboard-chat): a greeting and example questions while empty; your messages as bubbles on
 * the right, replies (and a failed send's error with Try again) as plain text on the left; the composer stays at the bottom while the conversation scrolls.
 */
export function ChatPage() {
  const client = useQueryClient();
  const session = useApi<Session>(API.session, false);
  const token = session.data?.csrf_token;
  // Its query function hands back what is cached, so a refresh (r) keeps the conversation.
  const { data: chat = EMPTY } = useQuery({ queryKey: KEY, queryFn: () => client.getQueryData<Conversation>(KEY) ?? EMPTY, initialData: EMPTY, staleTime: Infinity, gcTime: Infinity });
  const update = (f: (c: Conversation) => Conversation) => client.setQueryData<Conversation>(KEY, (c) => f(c ?? EMPTY));
  const [text, setText] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  const follow = useRef(true);
  const itemId = itemOf();
  const hint = useId();

  // The app's content column scrolls (App.tsx `data-scroll-root`): follow new messages only while it is read to its end.
  useEffect(() => {
    const root = document.querySelector("[data-scroll-root]");
    if (!root) return;
    const onScroll = () => {
      follow.current = root.scrollHeight - root.scrollTop - root.clientHeight < NEAR_END;
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => root.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => {
    const root = document.querySelector("[data-scroll-root]");
    // To the very end: the newest message then sits just above the composer, not under it.
    if (root && follow.current) root.scrollTop = root.scrollHeight;
  }, [chat.said.length, chat.pending]);

  // One line, growing with the text up to MAX_LINES, then it scrolls.
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    const s = getComputedStyle(el);
    const line = Number.parseFloat(s.lineHeight) || 20;
    const max = line * MAX_LINES + Number.parseFloat(s.paddingTop || "0") + Number.parseFloat(s.paddingBottom || "0") + 2;
    el.style.height = `${Math.min(el.scrollHeight + 2, max)}px`;
    el.style.overflowY = el.scrollHeight + 2 > max ? "auto" : "hidden";
  }, [text]);

  /** Sends `message` (a new one, or the failed message `retry` again) and adds the reply or the error under it. */
  const send = async (message: string, retry?: number) => {
    if (message === "" || token === undefined || client.getQueryData<Conversation>(KEY)?.pending) return;
    const id = retry ?? Date.now();
    follow.current = true;
    const controller = new AbortController();
    const { signal } = controller;
    // Stop ended this send: nothing of it lands any more, and a newer send owns the conversation.
    const settle = (f: (c: Conversation) => Conversation) => {
      if (!signal.aborted) update((c) => ({ ...f(c), pending: undefined }));
    };
    update((c) => ({
      ...c,
      pending: { controller, startedAt: Date.now() },
      said: retry === undefined ? [...c.said, { id, who: "you", text: message }] : c.said.map((m) => (m.id === retry && m.who === "you" ? { id, who: "you", text: m.text } : m)),
    }));
    const fail = (error: string) => settle((c) => ({ ...c, said: c.said.map((m) => (m.id === id && m.who === "you" ? { ...m, error } : m)) }));
    try {
      // The item's title, state and stage come from the stored items list, so the chat can answer "What is this?".
      const list = itemId === null ? null : await client.fetchQuery({ queryKey: ["chat", "items"], queryFn: () => itemsList({}), staleTime: 10_000 });
      const item = list?.items.find((i) => i.id === itemId);
      const context = item === undefined ? "" : `${t("chat.contextItem", { title: item.title ?? t("chat.untitled"), state: item.state_label, stage: item.stage })}\n\n`;
      if (signal.aborted) return;
      const sessionId = client.getQueryData<Conversation>(KEY)?.sessionId;
      const res = await chatSend(token, { ...(sessionId === undefined ? {} : { session_id: sessionId }), text: `${context}${message}` }, signal);
      if (signal.aborted) return;
      if (res.status === 503) fail(t("chat.off"));
      else if (!res.ok) fail(t("chat.sendFailed", { reason: res.value.error ?? "" }).trim());
      else if (res.value.outcome !== "answered" || res.value.reply === undefined) {
        update((c) => ({ ...c, sessionId: res.value.session_id }));
        fail(t("chat.noReply", { reason: reasonWords(res.value.reason, res.value.detail) }));
      } else {
        const reply = res.value.reply;
        settle((c) => ({ ...c, sessionId: res.value.session_id, said: [...c.said, { id: id + 0.5, who: "chat", text: reply }] }));
      }
    } catch {
      fail(t("chat.failedRead"));
    }
  };

  /** Stop: abort the request and end the wait at once. The server's turn runs on; its reply is not shown. */
  const stop = () => {
    const pending = client.getQueryData<Conversation>(KEY)?.pending;
    if (!pending) return;
    pending.controller.abort();
    update((c) => ({ ...c, pending: undefined, said: [...c.said, { id: Date.now() + 0.25, who: "chat", text: t("chat.stopped") }] }));
  };

  const submit = () => {
    const message = text.trim();
    if (message === "" || chat.pending || token === undefined) return;
    setText("");
    void send(message);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter is a new line. An IME's Enter (composing Korean or Japanese) only ends the composition.
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    submit();
  };

  const empty = chat.said.length === 0;
  return (
    <div data-page-fill className="mx-auto flex w-full max-w-[48rem] min-w-0 flex-1 flex-col">
      <PageHeader title={t("page.chat")} />
      {empty ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-6 py-10 text-center">
          <div className="space-y-2">
            <p className="text-lg font-semibold text-balance">{t("chat.greeting")}</p>
            <p className="mx-auto max-w-md text-sm text-pretty text-text-2">{t("chat.greetingBody")}</p>
          </div>
          <ul aria-label={t("chat.examples")} className="flex max-w-xl flex-wrap justify-center gap-2">
            {EXAMPLES.map((key) => (
              <li key={key}>
                <Button
                  className="rounded-pill!"
                  onClick={() => {
                    setText(t(key));
                    field.current?.focus();
                  }}
                >
                  {t(key)}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <ol aria-label={t("chat.conversation")} className="flex min-w-0 flex-1 flex-col gap-8 pb-8">
          {chat.said.map((m) =>
            m.who === "you" ? (
              <Fragment key={m.id}>
                <li data-from="you" className="flex min-w-0 flex-col items-end">
                  <span className="sr-only">{t("chat.you")}</span>
                  <p data-raw className="max-w-[85%] min-w-0 rounded-card bg-surface-2 px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap wrap-anywhere">
                    {m.text}
                  </p>
                </li>
                {/*
                  A failed send reads as the chat's turn: where its answer would be, at the left. The text may hold one long
                  unbroken token (a request id, a path), so it breaks anywhere and Try again wraps under it when it runs out of room.
                */}
                {m.error !== undefined && (
                  <li data-from="chat" data-send-error className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
                    <span className="sr-only">{t("chat.reply")}</span>
                    <p role="alert" data-raw className="max-w-full min-w-0 text-sm text-pretty text-failed wrap-anywhere">{m.error}</p>
                    <Button variant="secondary" size="sm" disabled={chat.pending !== undefined} onClick={() => void send(m.text, m.id)}>
                      {t("chat.retry")}
                    </Button>
                  </li>
                )}
              </Fragment>
            ) : (
              <li key={m.id} data-from="chat" className="min-w-0">
                <span className="sr-only">{t("chat.reply")}</span>
                <ChatReply text={m.text} />
              </li>
            ),
          )}
          {chat.pending && (
            <li data-from="chat">
              <Answering />
            </li>
          )}
        </ol>
      )}
      {/*
        Pinned to the bottom of the scrolling column; the page's colour behind it, faded in above it, hides the messages
        scrolling under. The safe-area inset keeps it above a phone's home indicator.
      */}
      <form
        className="sticky bottom-0 bg-bg pt-2 pb-[env(safe-area-inset-bottom)] before:pointer-events-none before:absolute before:inset-x-0 before:-top-6 before:h-6 before:bg-linear-to-t before:from-bg"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="relative">
          <Textarea
            ref={field}
            aria-label={t("chat.field")}
            aria-describedby={hint}
            placeholder={t("chat.placeholder")}
            rows={1}
            className="block w-full resize-none rounded-card! py-3 pr-14 pl-4 leading-5 shadow-sm"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
          />
          {chat.pending === undefined && (
            <Button
              type="submit"
              variant="primary"
              size="icon"
              aria-label={t("chat.send")}
              disabled={text.trim() === "" || token === undefined}
              className="absolute right-2 bottom-1.5 rounded-pill!"
            >
              <ArrowUp aria-hidden className="size-4" />
            </Button>
          )}
        </div>
        {chat.pending !== undefined && (
          <div className="flex items-center justify-end gap-3 pt-2">
            <Elapsed startedAt={chat.pending.startedAt} />
            <Button type="button" variant="secondary" size="md" onClick={stop}>
              {t("chat.stop")}
            </Button>
          </div>
        )}
        <p id={hint} className="py-2 text-center text-xs text-text-3">{t("chat.hint")}</p>
      </form>
    </div>
  );
}
