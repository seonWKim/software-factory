import { useQueryClient } from "@tanstack/react-query";
import { Fragment, type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { API, type ItemDetail, type ItemRow, type Items, type Session, useApi } from "./api.js";
import { Button } from "./components/ui/button.js";
import { SUB_TITLE } from "./components/ui/card.js";
import { Input } from "./components/ui/input.js";
import { cn } from "./lib/cn.js";
import { Kbd } from "./components/ui/notice.js";
import { SHORTCUTS, SHORTCUT_GROUPS, type Shortcut, type ShortcutGroup } from "./keys.js";
import { t } from "./i18n/index.js";
import { type MessageKey } from "./i18n/en.js";
import { BASE, PAGES, itemPath } from "./pages.js";
import { ModalPanel, announceStatus } from "./components/ui/dialog.js";
import { useCommandSend } from "./views/command-send.js";
import { withPaths } from "./views/item-commands.js";
import { ApproveDialog, approvePhase, chosenAnswers, commandLabel, initialChoices } from "./views/item-decisions.js";

// ⌘K search (design §9): the pages, the items the page has already loaded (the cached /api/v1/items reads) and the
// closed items of the existing closed=1 read, the actions, and the command help. No search endpoint.
//
// The actions (design 09-dashboard-shell): "Approve: <title>" for each loaded open item whose approve the viewer may
// send (its row's `commands`), which sends approve through the item commands route as the item page's button does,
// opening the same approve dialog first when that button does (approvePhase); and "Go to Runners" (Health's tab).
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
    <section aria-label={t("commands.label")} data-command-help className="mt-5 border-t border-border pt-4">
      <h3 className={cn(SUB_TITLE, "mb-2")}>{t("commands.label")}</h3>
      <dl className="space-y-3">
        {shown.map((c) => (
          <div key={c.usage}>
            <dt><code className="rounded-control bg-surface-2 px-1.5 py-0.5 font-mono text-xs break-all text-text-1">{c.usage}</code></dt>
            <dd className="mt-1 text-pretty text-text-2">{t(c.what)}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-4 text-xs text-pretty text-text-2">{t("commands.helpWhere")}</p>
    </section>
  );
}

/** The page whose raw names are meant for developers: ⌘K lists it as a developer page. */
const DEVELOPER_PAGE = "data";

interface Hit {
  /** Unique among the hits: the page it goes to, or `approve:<id>`. */
  key: string;
  label: string;
  group: "search.pages" | "search.developer" | "search.items" | "search.merged" | "search.closed" | "search.actions";
  /** Where it goes; none for an approve, which `approve` runs. */
  to?: string;
  approve?: ItemRow;
}

/** The Runners tab of Health, which "Go to Runners" opens. */
const RUNNERS = `${BASE}health?tab=runners`;

/** The items any list of the page has loaded, by id. */
function loadedItems(client: ReturnType<typeof useQueryClient>): ItemRow[] {
  const seen = new Map<string, ItemRow>();
  for (const [, data] of client.getQueriesData<Items>({ predicate: (q) => typeof q.queryKey[0] === "string" && q.queryKey[0].startsWith(API.items) })) {
    for (const i of data?.items ?? []) if (!seen.has(i.id)) seen.set(i.id, i);
  }
  return [...seen.values()];
}

/** An item's hit: a closed one is labelled Merged (completed) or Closed; a withheld title shows the id. */
function itemHit(i: ItemRow): Hit {
  const group = i.stage !== "CLOSED" ? "search.items" : i.close_reason === "completed" ? "search.merged" : "search.closed";
  return { key: itemPath(i.id), to: itemPath(i.id), label: i.title ?? i.id, group };
}

/** The approve the viewer may send on loaded open item `i`, from its row's commands; undefined when it has none. */
const approveOf = (i: ItemRow) => (i.stage === "CLOSED" ? undefined : i.commands?.find((c) => c.name === "approve" && c.allowed));

/**
 * Approve from ⌘K: the item page's approve. Where its button opens the approve dialog (a held spec, floor or Rule of Two
 * step: approvePhase), the same dialog, with the spec's default answers, and nothing sent before its confirm; else sent
 * at once. Either way POST /api/v1/items/:id/commands with `approve`; `onClose` once it is sent or cancelled.
 */
function SearchApprove({ row, onClose }: { row: ItemRow; onClose: () => void }) {
  const { on, busy, local, send } = useCommandSend(row.id);
  const phase = approvePhase(row.blocked_reason);
  const detail = useApi<ItemDetail>(API.item(row.id), false);
  const title = row.title ?? row.id;
  const sent = useRef(false);
  const done = () => {
    announceStatus(t("search.approveSent", { title }));
    onClose();
  };
  const command = approveOf(row);
  useEffect(() => {
    // Sent once, however often the effect runs; the session's token first.
    if (phase !== null || !on || sent.current || !command) return;
    sent.current = true;
    void send("approve", withPaths(command, "")).then((ok) => (ok ? done() : onClose()));
  }, [on]);
  if (phase === null || !detail.data) return null;
  const decisions = phase === "spec_pending" || phase === "max_revisions" ? (detail.data.spec?.decisions ?? []) : [];
  return (
    <ApproveDialog
      title={`${commandLabel("approve")} ${title}`}
      phase={phase}
      answers={chosenAnswers(decisions, initialChoices(decisions))}
      note=""
      busy={busy || !on}
      error={local.approve && "error" in local.approve ? local.approve.error : null}
      returnFocusTo={{ current: null }}
      onSend={(text) => void send("approve", text).then((ok) => ok && done())}
      onClose={onClose}
    />
  );
}

/** The search: type to filter, arrows to move, Enter or a click to go there, Escape to close. */
export function SearchDialog({ navigate, onClose }: { navigate: (to: string) => void; onClose: () => void }) {
  const client = useQueryClient();
  const [text, setText] = useState("");
  const [at, setAt] = useState(0);
  const [approving, setApproving] = useState<ItemRow | null>(null);
  // The closed items come from the existing closed=1 read (newest LIST_LIMIT), which the default read leaves out.
  const closed = useApi<Items>(`${API.items}?closed=1`);
  // Commands off for this page's session: no approve to offer.
  const commandsOn = useApi<Session>(API.session, false).data?.commands_enabled === true;
  const hits = useMemo<Hit[]>(() => {
    const loaded = loadedItems(client);
    const items = loaded.map(itemHit);
    const approvals: Hit[] = commandsOn
      ? loaded.filter((i) => approveOf(i) !== undefined).map((i) => ({ key: `approve:${i.id}`, label: t("search.approve", { title: i.title ?? i.id }), group: "search.actions", approve: i }))
      : [];
    const all: Hit[] = [
      ...PAGES.map((p) => ({ key: BASE + p.path, to: BASE + p.path, label: t(`page.${p.key}` as MessageKey), group: (p.path === DEVELOPER_PAGE ? "search.developer" : "search.pages") as Hit["group"] })),
      ...items.filter((h) => h.group === "search.items"),
      ...items.filter((h) => h.group !== "search.items"),
      // Last, so Enter on a search for an item's title opens it and never approves it.
      ...approvals,
      { key: RUNNERS, to: RUNNERS, label: t("search.goRunners"), group: "search.actions" },
    ];
    const q = text.trim().toLowerCase();
    return q ? all.filter((h) => h.label.toLowerCase().includes(q) || (h.to ?? "").toLowerCase().includes(q)) : all;
  }, [client, text, closed.data, commandsOn]);
  const go = (h: Hit | undefined) => {
    if (!h) return;
    if (h.approve) {
      setApproving(h.approve);
      return;
    }
    onClose();
    if (h.to) navigate(h.to);
  };
  if (approving) return <SearchApprove row={approving} onClose={onClose} />;
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
    <ModalPanel
      title={t("search.open")}
      size="md"
      placement="top"
      onClose={onClose}
      header={
        <Input
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
      }
    >
      {hits.length === 0 ? (
        <p className="text-text-2">{t("search.none")}</p>
      ) : (
        <ul role="listbox" aria-label={t("search.open")} className="space-y-0.5">
          {hits.map((h, i) => (
            <li key={h.key} role="option" aria-selected={i === at}>
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
    </ModalPanel>
  );
}

/** Each shortcut group's label. */
const GROUP_LABEL: Record<ShortcutGroup, MessageKey> = {
  general: "keys.group.general",
  navigation: "keys.group.navigation",
  rows: "keys.group.rows",
  tasks: "keys.group.tasks",
};

/** One shortcut's keys: each key of a sequence ("g w") in its own Kbd, alternatives joined by "or". */
function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="flex shrink-0 flex-wrap items-center justify-end gap-1">
      {keys.map((k, i) => (
        <Fragment key={k}>
          {i > 0 && <span className="px-0.5 text-xs text-text-3">{t("keys.or")}</span>}
          {k.split(" ").map((part, j) => (
            <Fragment key={part + j}>
              {j > 0 && " "}
              <Kbd>{part}</Kbd>
            </Fragment>
          ))}
        </Fragment>
      ))}
    </span>
  );
}

/** The shortcuts by group, one row per action (its keys at the right), then the command help. */
export function HelpDialog({ onClose }: { onClose: () => void }) {
  const groups = SHORTCUT_GROUPS.map((group) => {
    const rows = new Map<Shortcut["what"], string[]>();
    for (const s of SHORTCUTS) if (s.group === group) rows.set(s.what, [...(rows.get(s.what) ?? []), s.keys]);
    return { group, rows: [...rows] };
  });
  return (
    <ModalPanel title={t("keys.title")} onClose={onClose}>
      <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
        {groups.map(({ group, rows }) => (
          <section key={group} aria-label={t(GROUP_LABEL[group])}>
            <h3 className={cn(SUB_TITLE, "mb-1")}>{t(GROUP_LABEL[group])}</h3>
            <ul>
              {rows.map(([what, keys]) => (
                <li key={what} className="flex items-center justify-between gap-4 py-1.5">
                  <span className="min-w-0 text-pretty">{t(what)}</span>
                  <Keys keys={keys} />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <CommandHelp />
    </ModalPanel>
  );
}
