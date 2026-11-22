import { useMemo, useState } from "react";
import { API, type ItemRow, type Items, type Overview, type SystemAction, mergeInFlight, useApi, useItems } from "../api.js";
import { Button } from "../components/ui/button.js";
import { Dialog } from "../components/ui/dialog.js";
import { LINK_CLASS } from "../components/ui/link-style.js";
import { ErrorNote } from "../components/ui/parts.js";
import type { MessageKey } from "../i18n/en.js";
import { shortSource, whyText } from "../lib/format.js";
import { t } from "../i18n/index.js";
import { Link } from "../nav.js";
import { itemPath } from "../pages.js";
import { type NeedGroup, MergeCheckNote, allowEntries, needGroup, needsYou } from "./common.js";
import { ItemDecision } from "./decision-card.js";
import { useCommandSend } from "./command-send.js";
import { NeedActions, SendErrors } from "./item-commands.js";
import { FloorStatus } from "./pages.js";
import { CheckRow } from "./system-banner.js";
import { Card } from "../components/ui/card.js";
import { Badge, StatusBadge } from "../components/ui/badge.js";
import { ListRow, ROW_TITLE } from "../components/ui/list-row.js";
import type { MenuItem } from "../components/ui/menu.js";
import { cn } from "../lib/cn.js";

/**
 * A built task's work item state as one pill: the state table's label, except that a Merge under way says where it
 * is, as the item page's button does (the server's pending request rule: "Merge queued (position N)", "Checking
 * build"), with no Merge button.
 */
const ItemState = ({ it }: { it: ItemRow }) => <StatusBadge state={it.item_phase}>{mergeInFlight(it.merge) ? it.merge.reason : undefined}</StatusBadge>;

/** A reason that is only a short status code ("failed: spec_conflict"): shown as a chip beside the badge, not as a line. */
const CODE_REASON = /^[a-z][a-z ]{0,20}: [a-z0-9_.-]{1,40}$/i;
/** An Answer-or-fix item's reason (the need's, else the why's en.ts text); empty for Merge and Approve, which say it with the badge. */
const needReason = (it: ItemRow): string => (needGroup(it) === "answer" ? (it.need?.reason ?? (it.why ? whyText(it.why) : "")) : "");

/**
 * The "⋯" menu of a waiting item, as in every Needs you row: its primary command first (Merge, Approve, Retry or
 * Answer), then its other commands, then `extra` (the row's own actions). `cmd`: the row's sends (useCommandSend);
 * `inlineErrors` false leaves a failed send's error to the row.
 */
function RowActions({ it, cmd, inlineErrors = true, extra, label }: { it: ItemRow; cmd: ReturnType<typeof useCommandSend>; inlineErrors?: boolean; extra?: readonly MenuItem[]; label?: string }) {
  const checking = it.merge_check?.state === "checking";
  return <NeedActions id={it.id} title={it.title ?? it.id} commands={it.commands ?? []} pr={it.change_ref} group={needGroup(it)} merge={it.merge} checking={checking} cmd={cmd} allow={allowEntries(needReason(it))} inlineErrors={inlineErrors} extra={extra} label={label} />;
}

/** The work item a built task links to, from the items list; undefined while it loads or when the list lacks it. */
export function useWorkItem(id: string | null): ItemRow | undefined {
  const items = useApi<Items>(API.items).data?.items;
  return id === null ? undefined : items?.find((i) => i.id === id);
}

/** True when the item waits on the owner (it is in Needs you): an open task's row then puts its commands in the row's menu. */
export const waitsOnOwner = (it: ItemRow | undefined): it is ItemRow => it !== undefined && needsYou([it]).length > 0;

/** An open task's menu when its work item waits on the owner: the item's commands first, then the task's own `extra`. */
export function TaskItemMenu({ it, extra, label }: { it: ItemRow; extra: readonly MenuItem[]; label: string }) {
  const cmd = useCommandSend(it.id);
  return <RowActions it={it} cmd={cmd} extra={extra} label={label} />;
}

/**
 * The work item's state on a task's row. On an open task's row (`open`) a waiting item shows its state badge, its
 * commands in the row's menu (it is a Needs you row too); a done task's row keeps the plain state. Any other state is a
 * button that opens its commands in a Dialog; nothing while the items list lacks the item.
 */
export function WorkState({ id, title, open: taskOpen }: { id: string; title: string; open: boolean }) {
  const it = useWorkItem(id);
  const [open, setOpen] = useState(false);
  if (!it) return null;
  // Its commands are in the row's menu (TaskItemMenu).
  if (taskOpen && waitsOnOwner(it)) return <ItemState it={it} />;
  return (
    <>
      <Button size="sm" variant="ghost" aria-label={t("tasks.stateOpen", { title })} onClick={() => setOpen(true)}>
        <ItemState it={it} />
      </Button>
      {open && (
        <Dialog title={it.title ?? title} confirmLabel={t("tasks.stateClose")} onConfirm={() => setOpen(false)} onClose={() => setOpen(false)}>
          <Link href={itemPath(id)} className={LINK_CLASS}>{t("tasks.stateFull")}</Link>
          <ItemDecision id={id} commands={it.commands ?? []} replies={[]} />
        </Dialog>
      )}
    </>
  );
}

const GROUPS: readonly [NeedGroup, MessageKey][] = [["merge", "needs.groupMerge"], ["approve", "needs.groupApprove"], ["answer", "needs.groupAnswer"]];

/**
 * One compact Needs you row: the item (and its PR), its state as one badge, a merge check only when it is not
 * "mergeable", the reason only for an Answer-or-fix item (Merge and Approve say it with the badge; it links to the item's latest
 * thread entry when the need names one), on the shared ListRow; every action is in its "⋯" menu, the primary first.
 * A failed send's error takes its own line below the row's content, never the menu cell (design-system/patterns.md C-050).
 */
function WorkRow({ it }: { it: ItemRow }) {
  const cmd = useCommandSend(it.id);
  const checking = it.merge_check?.state === "checking";
  const reason = needReason(it);
  const chip = CODE_REASON.test(reason);
  const toNeed = it.need?.anchor ? `${itemPath(it.id)}#${it.need.anchor}` : null;
  return (
    <ListRow
      data-key={it.id}
      title={
        <span className="flex min-w-0 items-baseline gap-2">
          <Link href={itemPath(it.id)} title={it.title ?? undefined} className={cn(ROW_TITLE, "text-text-1 hover:underline")}>
            {it.title ?? shortSource(it.source.id)}
          </Link>
          {it.change_ref !== null && <span className="shrink-0 text-xs text-text-2 tabular-nums">#{it.change_ref}</span>}
        </span>
      }
      details={
        <>
          <StatusBadge state={it.item_phase} />
          {it.merge_check && !checking && it.merge_check.state !== "mergeable" && <MergeCheckNote check={it.merge_check} />}
          {chip && (
            <span data-need title={reason}>
              {toNeed ? (
                <Link href={toNeed} className="rounded-pill hover:opacity-80">
                  <Badge>{reason}</Badge>
                </Link>
              ) : (
                <Badge>{reason}</Badge>
              )}
            </span>
          )}
          {reason !== "" && !chip && (
            <span data-need title={reason} className="min-w-0 flex-1 basis-40 truncate">
              {toNeed ? <Link href={toNeed} className={LINK_CLASS}>{reason}</Link> : reason}
            </span>
          )}
        </>
      }
      menu={<RowActions it={it} cmd={cmd} inlineErrors={false} />}
    >
      {Object.values(cmd.local).some((l) => "error" in l) && (
        <div data-row-error className="flex flex-col gap-1">
          <SendErrors local={cmd.local} />
        </div>
      )}
    </ListRow>
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
        <Card title={t("page.needs")} count={count}>
          <NeedsList items={needs} checks={checks} />
        </Card>
      )}
      {status}
    </>
  );
}
