import { useMemo, useState } from "react";
import { API, type ItemRow, type Items, useApi, useItems } from "../api.js";
import { Button } from "../components/ui/button.js";
import { Dialog } from "../components/ui/dialog.js";
import { LINK_CLASS } from "../components/ui/link-style.js";
import { ErrorNote, Section } from "../components/ui/parts.js";
import { StatusBadge } from "../components/ui/notice.js";
import type { MessageKey } from "../i18n/en.js";
import { LEVEL_LABELS, shortSource } from "../lib/format.js";
import { t } from "../i18n/index.js";
import { Link } from "../nav.js";
import { itemPath } from "../pages.js";
import { type NeedGroup, MergeCheckNote, allowEntries, needGroup, needsYou } from "./common.js";
import { ItemCommands, NeedActions, useCommandSend } from "./item-commands.js";

/** The five states a built task shows on its row, from its work item's level (src/ui/priority.ts); a closed item is "merged" only when it closed as completed. */
const STATE_OF: Record<string, MessageKey> = {
  needs_approval: "tasks.state.spec",
  running: "tasks.state.running",
  queued: "tasks.state.running",
  ready_to_merge: "tasks.state.merge",
  needs_you: "tasks.state.needs",
  needs_triage: "tasks.state.needs",
  stuck: "tasks.state.needs",
};

const stateKey = (it: ItemRow): MessageKey | null => (it.level === "closed" ? (it.close_reason === "completed" ? "tasks.state.merged" : null) : (STATE_OF[it.level] ?? null));

/** The work item's state as a button that opens its commands in a Dialog; nothing while the items list lacks the item. */
export function WorkState({ id, title }: { id: string; title: string }) {
  const items = useApi<Items>(API.items).data?.items;
  const it = items?.find((i) => i.id === id);
  const [open, setOpen] = useState(false);
  const key = it ? stateKey(it) : null;
  if (!it || key === null) return null;
  return (
    <>
      <Button size="sm" aria-label={t("tasks.stateOpen", { title })} onClick={() => setOpen(true)}>
        <StatusBadge level={it.level} size="sm">{t(key)}</StatusBadge>
      </Button>
      {open && (
        <Dialog title={it.title ?? title} confirmLabel={t("tasks.stateClose")} onConfirm={() => setOpen(false)} onClose={() => setOpen(false)}>
          <Link href={itemPath(id)} className={LINK_CLASS}>{t("tasks.stateFull")}</Link>
          <ItemCommands id={id} commands={it.commands ?? []} replies={[]} />
        </Dialog>
      )}
    </>
  );
}

const GROUPS: readonly [NeedGroup, MessageKey][] = [["merge", "needs.groupMerge"], ["approve", "needs.groupApprove"], ["answer", "needs.groupAnswer"]];

/**
 * One compact Factory work row: the item (and its PR), its state as one badge, a merge check only when it is not
 * "mergeable", the reason only for an Answer-or-fix item (Merge and Approve say it with the badge), and the primary action.
 */
function WorkRow({ it }: { it: ItemRow }) {
  const cmd = useCommandSend(it.id);
  const group = needGroup(it);
  const checking = it.merge_check?.state === "checking";
  const reason = group === "answer" ? (it.need?.reason ?? it.why?.text ?? "") : "";
  return (
    <li data-key={it.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 p-3">
      <div className="min-w-0 flex-1 space-y-1">
        <span className="flex min-w-0 items-baseline gap-2">
          <Link href={itemPath(it.id)} title={t("needs.idHover", { id: it.id })} className="truncate font-medium text-text-1 hover:underline">
            {it.title ?? shortSource(it.source.id)}
          </Link>
          {it.change_ref !== null && <span className="shrink-0 text-xs text-text-2 tabular-nums">#{it.change_ref}</span>}
        </span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <StatusBadge level={it.level} size="sm">{LEVEL_LABELS[it.level] ?? it.level}</StatusBadge>
          {it.merge_check && !checking && it.merge_check.state !== "mergeable" && <MergeCheckNote check={it.merge_check} />}
        </span>
        {reason !== "" && <p data-need title={reason} className="line-clamp-2 text-xs break-words text-text-2">{reason}</p>}
      </div>
      <NeedActions id={it.id} title={it.title ?? it.id} commands={it.commands ?? []} pr={it.change_ref} group={group} merge={it.merge} source={it.source.type} checking={checking} cmd={cmd} allow={allowEntries(reason)} />
    </li>
  );
}

/**
 * Factory work: the open items that need the owner as one compact list per group (Merge, Approve, Answer or fix), one
 * state badge per row and no table header; with `project` (the Tasks page's switcher) only those built from a task in
 * that project. Nothing shows when none waits. Needs you keeps its own table.
 */
export function FactoryWork({ project }: { project: string | null }) {
  const items = useItems(project);
  const rows = items.data?.items;
  const needs = useMemo(() => needsYou(rows ?? []), [rows]);
  if (items.isError) return <ErrorNote error={items.error} />;
  const groups = GROUPS.map(([group, title]) => ({ title: t(title), rows: needs.filter((it) => needGroup(it) === group) })).filter((g) => g.rows.length > 0);
  if (groups.length === 0) return null;
  return (
    <Section title={t("tasks.factoryWork")}>
      <div className="space-y-3">
        {groups.map((g) => (
          <div key={g.title} className="space-y-1">
            <h3 className="text-xs font-medium text-text-2">{g.title}</h3>
            <ul aria-label={g.title} className="divide-y divide-border rounded-control border border-border">
              {g.rows.map((it) => <WorkRow key={it.id} it={it} />)}
            </ul>
          </div>
        ))}
      </div>
    </Section>
  );
}
