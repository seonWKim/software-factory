import { useQueryClient } from "@tanstack/react-query";
import { type JSX, type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { API, type Items } from "./api.js";
import { Button } from "./components/ui/button.js";
import { ButtonRow } from "./components/ui/button-row.js";
import { Input } from "./components/ui/input.js";
import { cn } from "./lib/cn.js";
import { SHORTCUTS } from "./keys.js";
import { t } from "./i18n/index.js";
import { type MessageKey } from "./i18n/en.js";
import { BASE, PAGES, itemPath } from "./pages.js";

// ⌘K search (design §9): the pages and the items the page has already loaded (the cached /api/v1/items reads),
// and the command help. No search endpoint and no request of its own.
//
// The command help (design 09-dashboard-item-commands): every item command, from a static list, as it is typed on a
// source or in a terminal, with what it does. The item page's DecisionCard has a button for each one an item accepts;
// the help is behind ? (with the shortcuts) and ⌘K (filtered by the search text), never in a page's body.

/** Every item command as it is typed, with what it does (static: the same list whatever page or item is open). */
const COMMAND_HELP: readonly { usage: string; what: MessageKey }[] = [
  { usage: "/approve [notes]", what: "commands.help.approve" },
  { usage: "/revise <feedback>", what: "commands.help.revise" },
  { usage: "/reject <reason>", what: "commands.help.reject" },
  { usage: "/retry", what: "commands.help.retry" },
  { usage: "/resolve [notes]", what: "commands.help.resolve" },
  { usage: "+paths <path>...", what: "commands.help.paths" },
  { usage: "/verdict accept|changes|reject <severity> <reason>", what: "commands.help.verdict" },
  { usage: "/budget [tokens]", what: "commands.help.budget" },
  { usage: "/standing [accept|decline <rule>]", what: "commands.help.standing" },
  { usage: "factory merge <item>", what: "commands.help.merge" },
];

/** The command help: each command whose usage or text holds `filter` (all when it is empty), and how to type them. */
function CommandHelp({ filter = "" }: { filter?: string }) {
  const q = filter.trim().toLowerCase();
  const shown = COMMAND_HELP.filter((c) => !q || c.usage.toLowerCase().includes(q) || t(c.what).toLowerCase().includes(q));
  if (shown.length === 0) return null;
  return (
    <section aria-label={t("commands.label")} data-command-help className="mt-3">
      <h2 className="mb-1 text-sm font-semibold">{t("commands.label")}</h2>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
        {shown.map((c) => (
          <div key={c.usage} className="contents">
            <dt><code className="font-mono text-xs break-all">{c.usage}</code></dt>
            <dd>{t(c.what)}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-xs text-text-2">{t("commands.helpWhere")}</p>
    </section>
  );
}

/** The page whose raw names are meant for developers: ⌘K lists it as a developer page. */
const DEVELOPER_PAGE = "data";

interface Hit {
  to: string;
  label: string;
  group: "search.pages" | "search.developer" | "search.items";
}

/** The items any list of the page has loaded, by id. */
function loadedItems(client: ReturnType<typeof useQueryClient>): { id: string; title: string | null }[] {
  const seen = new Map<string, string | null>();
  for (const [, data] of client.getQueriesData<Items>({ predicate: (q) => typeof q.queryKey[0] === "string" && q.queryKey[0].startsWith(API.items) })) {
    for (const i of data?.items ?? []) if (!seen.has(i.id)) seen.set(i.id, i.title);
  }
  return [...seen].map(([id, title]) => ({ id, title }));
}

/** A modal frame: Escape and the Close button close it. */
function Dialog({ label, onClose, children }: { label: string; onClose: () => void; children: JSX.Element | JSX.Element[] }) {
  const frame = useRef<HTMLDivElement>(null);
  // Focus goes into the dialog (unless a field in it took it), so Escape reaches it.
  useEffect(() => {
    if (!frame.current?.contains(document.activeElement)) frame.current?.focus();
  }, []);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-text-1/40 p-4 pt-[10dvh]" onKeyDown={onKey}>
      <div ref={frame} tabIndex={-1} role="dialog" aria-modal="true" aria-label={label} className="max-h-[80dvh] w-full max-w-md overflow-y-auto rounded-control outline-none border border-border bg-surface p-3 text-sm shadow-lg">
        {children}
        <ButtonRow className="mt-3 justify-end">
          <Button onClick={onClose}>{t("keys.close")}</Button>
        </ButtonRow>
      </div>
    </div>
  );
}

/** The search: type to filter, arrows to move, Enter or a click to go there, Escape to close. */
export function SearchDialog({ navigate, onClose }: { navigate: (to: string) => void; onClose: () => void }) {
  const client = useQueryClient();
  const [text, setText] = useState("");
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const hits = useMemo<Hit[]>(() => {
    const all: Hit[] = [
      ...PAGES.map((p) => ({ to: BASE + p.path, label: t(`page.${p.key}` as MessageKey), group: (p.path === DEVELOPER_PAGE ? "search.developer" : "search.pages") as Hit["group"] })),
      ...loadedItems(client).map((i) => ({ to: itemPath(i.id), label: i.title ?? i.id, group: "search.items" as const })),
    ];
    const q = text.trim().toLowerCase();
    return q ? all.filter((h) => h.label.toLowerCase().includes(q) || h.to.toLowerCase().includes(q)) : all;
  }, [client, text]);
  const go = (h: Hit | undefined) => {
    if (!h) return;
    onClose();
    navigate(h.to);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setAt((a) => Math.max(0, Math.min(hits.length - 1, a + (e.key === "ArrowDown" ? 1 : -1))));
    } else if (e.key === "Enter") {
      e.preventDefault();
      go(hits[at]);
    }
  };
  return (
    <Dialog label={t("search.open")} onClose={onClose}>
      <Input
        ref={input}
        type="search"
        value={text}
        placeholder={t("search.placeholder")}
        aria-label={t("search.placeholder")}
        onChange={(e) => {
          setText(e.target.value);
          setAt(0);
        }}
        onKeyDown={onKey}
        className="w-full"
      />
      {hits.length === 0 ? (
        <p className="mt-2 text-text-2">{t("search.none")}</p>
      ) : (
        <ul role="listbox" aria-label={t("search.open")} className="mt-2 space-y-0.5">
          {hits.map((h, i) => (
            <li key={h.to} role="option" aria-selected={i === at}>
              <Button
                variant="ghost"
                onClick={() => go(h)}
                className={cn("w-full py-1.5 text-left", i === at && "bg-surface-2")}
              >
                <span className="min-w-0 flex-1 break-words">{h.label}</span>
                <span className="shrink-0 text-xs text-text-2">{t(h.group)}</span>
              </Button>
            </li>
          ))}
        </ul>
      )}
      <CommandHelp filter={text} />
    </Dialog>
  );
}

/** The list of every shortcut, then the command help. */
export function HelpDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog label={t("keys.title")} onClose={onClose}>
      <h2 className="mb-2 text-sm font-semibold">{t("keys.title")}</h2>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
        {SHORTCUTS.map((s) => (
          <div key={s.keys} className="contents">
            <dt><kbd className="rounded-control border border-border-strong px-1.5 font-mono text-xs">{s.keys}</kbd></dt>
            <dd>{t(s.what)}</dd>
          </div>
        ))}
      </dl>
      <CommandHelp />
    </Dialog>
  );
}
