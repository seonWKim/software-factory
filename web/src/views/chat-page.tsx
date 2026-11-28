import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, RotateCw } from "lucide-react";
import { type ClipboardEvent, Fragment, type KeyboardEvent, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { API, type Session, useApi } from "../api.js";
import { chatSend, chatTranscript, chatTurns, itemsList } from "../api/generated.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { ButtonRow } from "../components/ui/button-row.js";
import { Card } from "../components/ui/card.js";
import { CopyIcon } from "../components/ui/copy.js";
import { ROW_TITLE, ListRow } from "../components/ui/list-row.js";
import { Markdown } from "../components/ui/markdown.js";
import { OverflowMenu } from "../components/ui/menu.js";
import { EmptyState } from "../components/ui/notice.js";
import { ErrorNote, LIST_BOX, Loading } from "../components/ui/parts.js";
import { Textarea } from "../components/ui/textarea.js";
import { TypingDots } from "../components/ui/typing-dots.js";
import { type MessageKey } from "../i18n/en.js";
import { t } from "../i18n/index.js";
import { cn } from "../lib/cn.js";
import { localDateTime, relativeTime } from "../lib/format.js";
import { OUTCOME_TONE, OUTCOME_WORDS, ReplyTable, type Turn, reasonWords, replyParts, withoutContext } from "./chat-card.js";
import { ChatDecision, ModeBadge } from "./chat-decision.js";
import { AttachImages, ComposerTray, type SentImage, SentImages, pastedImages, useComposerImages, useImageDrop } from "./chat-images.js";
import { useNow } from "./display.js";

// The Chat page (design 09-dashboard-chat): one centred column, the conversation above and the composer pinned under
// it. It reads and writes through the generated typed client (web/src/api/generated.ts) only.

/**
 * One message: yours (its images, and the error of its send, if it failed) or the chat's reply (with a note naming any
 * image that was not sent).
 */
type Said = { id: number; who: "you"; text: string; images?: SentImage[]; error?: string } | { id: number; who: "chat"; text: string; note?: string };

interface Conversation {
  said: Said[];
  sessionId?: string;
  /** The send on its way: its AbortController (Stop) and when it started (the elapsed line). */
  pending?: { controller: AbortController; startedAt: number } | undefined;
}

const EMPTY: Conversation = { said: [] };
// Kept in the query cache, not in the page: going to another page and back keeps the conversation and its session, and a
// send that finishes while the page is away still lands. A reload starts empty; Recent lists the stored sessions.
const KEY = ["chat", "conversation"] as const;

/** The example questions of the empty page; one click puts the question in the composer. */
const EXAMPLES: readonly MessageKey[] = ["chat.example.needs", "chat.example.working", "chat.example.failed", "chat.example.cost"];

/** The composer grows from one line up to this many, then scrolls. */
const MAX_LINES = 8;

/** Within this many pixels of the end, the column counts as read to the end and follows new messages. */
const NEAR_END = 80;

/** A reply as readable markdown: paragraphs, lists and code blocks in Markdown, a pipe table as a DataTable. */
function ChatReply({ text, note, regenerate }: { text: string; note?: string | undefined; regenerate?: { onClick: () => void; disabled: boolean } }) {
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
      {note !== undefined && <p data-raw className="text-sm text-text-2 wrap-anywhere">{note}</p>}
      {groups.map((g, i) => (g.kind === "md" ? <Markdown key={i} text={g.text} /> : <ReplyTable key={i} rows={g.rows} />))}
      <ButtonRow>
        <CopyIcon value={text} what={t("chat.copyReply")} />
        {regenerate && (
          <Button type="button" variant="ghost" size="icon" aria-label={t("chat.regenerate")} title={t("chat.regenerate")} disabled={regenerate.disabled} onClick={regenerate.onClick}>
            <RotateCw aria-hidden className="size-4" />
          </Button>
        )}
      </ButtonRow>
    </div>
  );
}

/** The names of the images a scan kept from the chat, as one plain sentence; undefined when none was. */
const withheldNote = (names: readonly string[] | undefined): string | undefined =>
  names?.length ? t("chat.imagesWithheld", { names: names.map((n) => `“${n}”`).join(", ") }) : undefined;

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
  return <p className="text-sm text-text-2">{seconds < ELAPSED_AFTER_S ? t("chat.sending") : t("chat.sendingFor", { seconds })}</p>;
}

/** The most sessions the Recent list shows, and how many turns are read to find them. */
const RECENT_SESSIONS = 10;
const RECENT_TURNS = 50;

/** The sessions of `turns` (newest first), each as its latest turn, at most RECENT_SESSIONS. */
function sessionsOf(turns: Turn[]): Turn[] {
  const seen = new Set<string>();
  const latest: Turn[] = [];
  for (const x of turns) {
    if (seen.has(x.session_id)) continue;
    seen.add(x.session_id);
    latest.push(x);
  }
  return latest.slice(0, RECENT_SESSIONS);
}

/** The Recent Card of the empty page: earlier sessions from chat.turns, read once when it mounts; Open loads one. */
function Recent({ onOpen }: { onOpen: (sessionId: string) => Promise<void> }) {
  const now = useNow();
  const [failed, setFailed] = useState(false);
  const q = useQuery({ queryKey: ["chat", "recent"], queryFn: () => chatTurns({ limit: RECENT_TURNS }) });
  const sessions = sessionsOf((q.data?.turns ?? []) as unknown as Turn[]);
  return (
    <Card title={t("chat.recent")}>
      {q.isError ? (
        <ErrorNote error={t("chat.recentFailed")} />
      ) : !q.data ? (
        <Loading rows={2} label="loading.chatRecent" onRetry={() => void q.refetch()} />
      ) : sessions.length === 0 ? (
        <EmptyState title={t("chat.recentNone")} description={t("chat.recentNoneBody")} />
      ) : (
        <ul aria-label={t("chat.recentList")} className={cn("divide-y divide-border text-left", LIST_BOX)}>
          {sessions.map((x) => {
            const when = relativeTime(x.created_at, now);
            return (
              <ListRow
                key={x.session_id}
                title={<span className={ROW_TITLE} title={localDateTime(x.created_at)}>{when}</span>}
                details={<>
                  <Badge level={OUTCOME_TONE[x.status]}>{OUTCOME_WORDS[x.status]()}</Badge>
                  {x.reason !== null && <span>{reasonWords(x.reason)}</span>}
                </>}
                menu={<OverflowMenu label={t("chat.openMenu", { when })} items={[{ label: t("chat.open"), onSelect: () => void onOpen(x.session_id).catch(() => setFailed(true)) }]} />}
              />
            );
          })}
        </ul>
      )}
      {failed && <ErrorNote error={t("chat.openFailed")} />}
    </Card>
  );
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
  const composer = useComposerImages();
  const drop = useImageDrop(composer.add);

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

  /** Sends `message` and its `images` (a new one, or the failed message `retry` again) and adds the reply or the error under it. */
  const send = async (message: string, images: SentImage[], retry?: number) => {
    if ((message === "" && images.length === 0) || token === undefined || client.getQueryData<Conversation>(KEY)?.pending) return;
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
      said: retry === undefined
        ? [...c.said, { id, who: "you", text: message, ...(images.length > 0 && { images }) }]
        : c.said.map((m) => (m.id === retry && m.who === "you" ? { id, who: "you", text: m.text, ...(m.images && { images: m.images }) } : m)),
    }));
    const fail = (error: string) => settle((c) => ({ ...c, said: c.said.map((m) => (m.id === id && m.who === "you" ? { ...m, error } : m)) }));
    try {
      // The item's title, state and stage come from the stored items list, so the chat can answer "What is this?".
      const list = itemId === null ? null : await client.fetchQuery({ queryKey: ["chat", "items"], queryFn: () => itemsList({}), staleTime: 10_000 });
      const item = list?.items.find((i) => i.id === itemId);
      const context = item === undefined ? "" : `${t("chat.contextItem", { title: item.title ?? t("chat.untitled"), state: item.state_label, stage: item.stage })}\n\n`;
      if (signal.aborted) return;
      const sessionId = client.getQueryData<Conversation>(KEY)?.sessionId;
      const res = await chatSend(
        token,
        {
          ...(sessionId === undefined ? {} : { session_id: sessionId }),
          text: message === "" ? message : `${context}${message}`,
          ...(images.length > 0 && { images: images.map(({ name, data }) => ({ name, data })) }),
        },
        signal,
      );
      if (signal.aborted) return;
      if (res.status === 503) fail(t("chat.off"));
      else if (!res.ok) fail(t("chat.sendFailed", { reason: res.value.error ?? "" }).trim());
      else if (res.value.outcome !== "answered" || res.value.reply === undefined) {
        update((c) => ({ ...c, sessionId: res.value.session_id }));
        const note = withheldNote(res.value.images_withheld);
        fail(note ?? t("chat.noReply", { reason: reasonWords(res.value.reason, res.value.detail) }));
      } else {
        const reply = res.value.reply;
        const note = withheldNote(res.value.images_withheld);
        settle((c) => ({ ...c, sessionId: res.value.session_id, said: [...c.said, { id: id + 0.5, who: "chat", text: reply, ...(note !== undefined && { note }) }] }));
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

  /** Send is on with text or at least one read image, once every image is read. */
  const canSend = (text.trim() !== "" || composer.ready > 0) && !composer.reading && chat.pending === undefined && token !== undefined;
  const submit = () => {
    if (!canSend) return;
    const message = text.trim();
    setText("");
    void send(message, composer.take());
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = pastedImages(e);
    if (files.length === 0) return;
    e.preventDefault();
    composer.add(files);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter is a new line. An IME's Enter (composing Korean or Japanese) only ends the composition.
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    submit();
  };

  /**
   * New chat: no messages, no typed text or images, no session: the next send starts a session of its own. A send still
   * on its way is stopped, so its reply does not land in the new chat.
   */
  const reset = () => {
    client.getQueryData<Conversation>(KEY)?.pending?.controller.abort();
    update(() => EMPTY);
    setText("");
    for (const i of composer.images) composer.remove(i.key);
  };

  /** Loads a stored session into the conversation, in order, and continues it with its session_id. */
  const open = async (sessionId: string) => {
    const { messages } = await chatTranscript({ session_id: sessionId });
    const said: Said[] = [];
    for (const m of messages) {
      if ((m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string" || m.content === "") continue;
      said.push(m.role === "user" ? { id: said.length, who: "you", text: withoutContext(m.content) } : { id: said.length, who: "chat", text: m.content });
    }
    follow.current = true;
    update(() => ({ said, sessionId }));
  };

  /** Regenerate: drops the newest reply and sends your message before it again, in its own bubble (send's retry branch). */
  const regenerate = (reply: number) => {
    const mine = chat.said[reply - 1];
    if (mine?.who !== "you") return;
    update((c) => ({ ...c, said: c.said.filter((m) => m.id !== chat.said[reply]?.id) }));
    void send(mine.text, mine.images ?? [], mine.id);
  };

  const empty = chat.said.length === 0;
  return (
    <div data-page-fill className="mx-auto flex w-full max-w-[48rem] min-w-0 flex-1 flex-col">
      {/* No visible title (owner, 2026-11-28): the sidebar already says Chat. The h1 stays for screen readers. */}
      <h1 className="sr-only">{t("page.chat")}</h1>
      {/* The page's own action row at the top right, in the place of a header's actions, with no title beside it. */}
      {/* The mode Badge sits at the start of the row, above the conversation (decision 2); New chat stays at the end. */}
      <div data-chat-actions className="flex min-w-0 flex-wrap items-center justify-between gap-2 pb-3">
        <ModeBadge />
        <Button variant="secondary" className="ms-auto" onClick={reset}>{t("chat.newChat")}</Button>
      </div>
      {/* Opened on an item (?item=): its Needs-you decision, first in the conversation (decisions 3 and 4). */}
      {itemId === null ? null : <ChatDecision item={itemId} token={token} />}
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
          <div className="w-full">
            <Recent onOpen={open} />
          </div>
        </div>
      ) : (
        <ol aria-label={t("chat.conversation")} className="flex min-w-0 flex-1 flex-col gap-8 pb-8">
          {chat.said.map((m, at) =>
            m.who === "you" ? (
              <Fragment key={m.id}>
                <li data-from="you" className="flex min-w-0 flex-col items-end">
                  <span className="sr-only">{t("chat.you")}</span>
                  {m.images && <SentImages images={m.images} />}
                  {m.text !== "" && (
                  <p data-raw className="max-w-[85%] min-w-0 rounded-card bg-surface-2 px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap wrap-anywhere">
                    {m.text}
                  </p>
                  )}
                  {m.text !== "" && <ButtonRow><CopyIcon value={m.text} what={t("chat.copyYours")} /></ButtonRow>}
                </li>
                {/*
                  A failed send reads as the chat's turn: where its answer would be, at the left. The text may hold one long
                  unbroken token (a request id, a path), so it breaks anywhere and Try again wraps under it when it runs out of room.
                */}
                {m.error !== undefined && (
                  <li data-from="chat" data-send-error className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
                    <span className="sr-only">{t("chat.reply")}</span>
                    <p role="alert" data-raw className="max-w-full min-w-0 text-sm text-pretty text-failed wrap-anywhere">{m.error}</p>
                    <Button variant="secondary" size="sm" disabled={chat.pending !== undefined} onClick={() => void send(m.text, m.images ?? [], m.id)}>
                      {t("chat.retry")}
                    </Button>
                  </li>
                )}
              </Fragment>
            ) : (
              <li key={m.id} data-from="chat" className="min-w-0">
                <span className="sr-only">{t("chat.reply")}</span>
                <ChatReply
                  text={m.text}
                  note={m.note}
                  {...(at === chat.said.length - 1 && chat.said[at - 1]?.who === "you" && { regenerate: { onClick: () => regenerate(at), disabled: chat.pending !== undefined } })}
                />
              </li>
            ),
          )}
          {chat.pending && (
            <li data-from="chat">
              <TypingDots label={t("chat.answering")} />
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
        {...drop.handlers}
      >
        <ComposerTray images={composer.images} remove={composer.remove} />
        <div data-dropping={drop.dragging || undefined} className={cn("relative rounded-card", drop.dragging && "ring-2 ring-focus")}>
          <AttachImages add={composer.add} disabled={chat.pending !== undefined} className="absolute bottom-1.5 left-2 rounded-pill!" />
          <Textarea
            ref={field}
            aria-label={t("chat.field")}
            aria-describedby={hint}
            placeholder={t("chat.placeholder")}
            rows={1}
            className="block w-full resize-none rounded-card! py-3 pr-14 pl-12 leading-5 shadow-sm"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
          {chat.pending === undefined && (
            <Button
              type="submit"
              variant="primary"
              size="icon"
              aria-label={t("chat.send")}
              disabled={!canSend}
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
