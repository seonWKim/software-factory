import { useMemo, useState } from "react";
import { API, type ItemRow, type Items, type Overview, type SystemAction, useApi, useItems } from "../api.js";
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
import { ItemCommands, NeedActions, SendErrors, useCommandSend } from "./item-commands.js";
import { FloorStatus } from "./pages.js";
import { CheckRow, NEED_ROW } from "./system-banner.js";

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

/** An Answer-or-fix item's reason (the need's, else the Why text); empty for Merge and Approve, which say it with the badge. */
const needReason = (it: ItemRow): string => (needGroup(it) === "answer" ? (it.need?.reason ?? it.why?.text ?? "") : "");

/**
 * The primary action and overflow menu of a waiting item (Merge, Approve, Retry, Answer, or Open), as in every Needs
 * you row. `cmd`: the row's sends (useCommandSend); `inlineErrors` false leaves a failed send's error to the row.
 */
function RowActions({ it, cmd, inlineErrors = true }: { it: ItemRow; cmd: ReturnType<typeof useCommandSend>; inlineErrors?: boolean }) {
  const checking = it.merge_check?.state === "checking";
  return <NeedActions id={it.id} title={it.title ?? it.id} commands={it.commands ?? []} pr={it.change_ref} group={needGroup(it)} merge={it.merge} source={it.source.type} checking={checking} cmd={cmd} allow={allowEntries(needReason(it))} inlineErrors={inlineErrors} />;
}

/**
 * The work item's state on a task's row. On an open task's row (`open`) a waiting item shows its state badge and its
 * one primary action (it is a Needs you row too); a done task's row keeps the plain state. Any other state is a
 * button that opens its commands in a Dialog; nothing while the items list lacks the item.
 */
export function WorkState({ id, title, open: taskOpen }: { id: string; title: string; open: boolean }) {
  const items = useApi<Items>(API.items).data?.items;
  const it = items?.find((i) => i.id === id);
  const [open, setOpen] = useState(false);
  const cmd = useCommandSend(id);
  const key = it ? stateKey(it) : null;
  if (!it || key === null) return null;
  if (taskOpen && needsYou([it]).length > 0) {
    return (
      <>
        <StatusBadge level={it.level} size="sm">{t(key)}</StatusBadge>
        <RowActions it={it} cmd={cmd} />
      </>
    );
  }
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
 * One compact Needs you row: the item (and its PR), its state as one badge, a merge check only when it is not
 * "mergeable", the reason only for an Answer-or-fix item (Merge and Approve say it with the badge; it links to the item's latest
 * thread entry when the need names one), and the primary action.
 * A failed send's error takes its own full-width line below the row's content, never the actions cell
 * (design-system/patterns.md C-050).
 */
function WorkRow({ it }: { it: ItemRow }) {
  const cmd = useCommandSend(it.id);
  const checking = it.merge_check?.state === "checking";
  const reason = needReason(it);
  return (
    <li data-key={it.id} className={NEED_ROW}>
      <div className="min-w-0 grow basis-64 space-y-1">
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
        {reason !== "" && (
          <p data-need title={reason} className="line-clamp-2 text-xs break-words text-text-2">
            {it.need?.anchor ? <Link href={`${itemPath(it.id)}#${it.need.anchor}`} className={LINK_CLASS}>{reason}</Link> : reason}
          </p>
        )}
      </div>
      <RowActions it={it} cmd={cmd} inlineErrors={false} />
      {Object.values(cmd.local).some((l) => "error" in l) && (
        <div data-row-error className="flex basis-full flex-col gap-1">
          <SendErrors local={cmd.local} />
        </div>
      )}
    </li>
  );
}

/**
 * The Needs you rows as one compact list per group: the waiting items under Merge, Approve, Answer or fix, then the
 * system actions (`checks`, each open alarm its own row) under Check, in that order; no group, no heading, for no row.
 */
export function NeedsList({ items, checks = [] }: { items: readonly ItemRow[]; checks?: readonly SystemAction[] }) {
  const groups = GROUPS.map(([group, title]) => ({ title: t(title), rows: items.filter((it) => needGroup(it) === group).map((it) => <WorkRow key={it.id} it={it} />) }))
    .concat({ title: t("needs.groupCheck"), rows: checks.map((a, i) => <CheckRow key={`${a.code}:${i}`} action={a} />) })
    .filter((g) => g.rows.length > 0);
  return (
    <div className="space-y-3">
      {groups.map((g) => (
        <div key={g.title} className="space-y-1">
          <h3 className="text-xs font-medium text-text-2">{g.title}</h3>
          <ul aria-label={g.title} className="divide-y divide-border rounded-control border border-border">
            {g.rows}
          </ul>
        </div>
      ))}
    </div>
  );
}

/**
 * The Tasks page's Needs you section (design 09-status-page): every open item that waits on the owner, also one shown
 * on an open task's row, and under All projects every system action in the Check group, with their count: the same
 * rows the overview's `needs_you` counts. `linked` (the open tasks' work item IDs) is null while the Tasks read loads,
 * and the section waits for it. `project` (the page's tabs) limits it to items built from that project's tasks, with
 * no Check group. Under All projects the factory's notice and claim pauses follow. Nothing shows when nothing waits.
 */
export function NeedsYou({ project, linked }: { project: string | null; linked: ReadonlySet<string> | null }) {
  const items = useItems(project);
  const overview = useApi<Overview>(API.overview);
  const rows = items.data?.items;
  const needs = useMemo(() => needsYou(rows ?? []), [rows]);
  const checks = project === null ? (overview.data?.system_actions ?? []) : [];
  const status = project === null && <FloorStatus />;
  if (items.isError) return <><ErrorNote error={items.error} />{status}</>;
  const count = needs.length + checks.length;
  return (
    <>
      {linked !== null && count > 0 && (
        <Section title={t("page.needs")} count={count}>
          <NeedsList items={needs} checks={checks} />
        </Section>
      )}
      {status}
    </>
  );
}
