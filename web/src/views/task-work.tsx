import { useEffect, useMemo, useState } from "react";
import { API, type ItemRow as Item, type Items, type Overview, type SystemAction, type UnreviewedMerges, mergeCheckLabel, mergeInFlight, useApi, useItems } from "../api.js";
import { Button } from "../components/ui/button.js";
import { Dialog } from "../components/ui/dialog.js";
import { BLOCK_LINK_CLASS, LINK_CLASS } from "../components/ui/link-style.js";
import { ErrorNote } from "../components/ui/parts.js";
import type { MessageKey } from "../i18n/en.js";
import { whyText } from "../lib/format.js";
import { t } from "../i18n/index.js";
import { Link } from "../nav.js";
import { itemPath } from "../pages.js";
import { type NeedGroup, allowEntries, needGroup, needsYou } from "./common.js";
import { ItemDecision } from "./decision-card.js";
import { useCommandSend } from "./command-send.js";
import { NeedActions, sendErrorTexts, useMergeReply } from "./item-commands.js";
import { FloorStatus } from "./pages.js";
import { CheckRow } from "./system-banner.js";
import { OutcomeText } from "./command-box.js";
import { Card, SUB_TITLE } from "../components/ui/card.js";
import { Badge, StatusBadge } from "../components/ui/badge.js";
import type { MenuItem } from "../components/ui/menu.js";
import { ListRow, ROW_TITLE } from "../components/ui/list-row.js";
import { cn } from "../lib/cn.js";
import { ItemRow } from "./item-row.js";
import { lastLook, markLook } from "../lib/last-look.js";

/**
 * A built task's work item state as one pill: the state table's label, except that a Merge under way says where it
 * is, as the item page's button does (the server's pending request rule: "Merge queued (position N)", "Checking
 * build"), with no Merge button.
 */
const ItemState = ({ it }: { it: Item }) => <StatusBadge state={it.item_phase}>{mergeInFlight(it.merge) ? it.merge.reason : undefined}</StatusBadge>;

/** A reason that is only a short status code ("failed: spec_conflict"): shown as a chip beside the badge, not as a line. */
const CODE_REASON = /^[a-z][a-z ]{0,20}: [a-z0-9_.-]{1,40}$/i;
/** An Answer-or-fix item's reason (the need's, else the why's en.ts text); empty for Merge and Approve, which say it with the badge. */
const needReason = (it: Item): string => (needGroup(it) === "answer" ? (it.need?.reason ?? (it.why ? whyText(it.why) : "")) : "");

/**
 * The "⋯" menu of a waiting item, as in every Needs you row: its primary command first (Merge, Approve, Retry or
 * Answer), then its other commands, then `extra` (the row's own actions). `cmd`: the row's sends (useCommandSend);
 * `inlineErrors` false leaves a failed send's error to the row.
 */
function RowActions({ it, cmd, inlineErrors = true, extra, label }: { it: Item; cmd: ReturnType<typeof useCommandSend>; inlineErrors?: boolean; extra?: readonly MenuItem[]; label?: string }) {
  const checking = it.merge_check?.state === "checking";
  return <NeedActions id={it.id} title={it.title ?? it.id} commands={it.commands ?? []} pr={it.change_ref} group={needGroup(it)} merge={it.merge} checking={checking} cmd={cmd} allow={allowEntries(needReason(it))} inlineErrors={inlineErrors} extra={extra} label={label} />;
}

/** The work item a built task links to, from the items list; undefined while it loads or when the list lacks it. */
export function useWorkItem(id: string | null): Item | undefined {
  const items = useApi<Items>(API.items).data?.items;
  return id === null ? undefined : items?.find((i) => i.id === id);
}

/** True when the item waits on the owner (it is in Needs you): an open task's row then puts its commands in the row's menu. */
export const waitsOnOwner = (it: Item | undefined): it is Item => it !== undefined && needsYou([it]).length > 0;

/** An open task's menu when its work item waits on the owner: the item's commands first, then the task's own `extra`. */
export function TaskItemMenu({ it, extra, label }: { it: Item; extra: readonly MenuItem[]; label: string }) {
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
 * One Needs you row, an ItemRow (comfortable, as every row on Tasks): its state as one badge (a merge check's
 * conflicts are that state: "Conflicts: N files", the files on hover, not "Ready to merge" beside them), the item's
 * title linking to it, then why: its rank reason, and the reason only for an Answer-or-fix item (Merge and Approve say
 * it with the badge; it links to the item's latest thread entry when the need names one). Every action is in its "⋯"
 * menu, the primary first; its PR, as a muted number, follows. A failed send's error and a merge's refusal are the
 * row's second line, never the menu cell (design-system/patterns.md C-050).
 */
function WorkRow({ it }: { it: Item }) {
  const cmd = useCommandSend(it.id);
  const merge = useMergeReply(it.id, needGroup(it), it.merge, cmd);
  const errors = [...new Set([...sendErrorTexts(cmd.local), ...(merge.outcome?.tone === "error" ? [merge.outcome.text] : [])])];
  const conflicts = it.merge_check?.state === "conflicts" ? it.merge_check : null;
  const reason = needReason(it);
  const chip = CODE_REASON.test(reason);
  const toNeed = it.need?.anchor ? `${itemPath(it.id)}#${it.need.anchor}` : null;
  return (
    <ItemRow
      variant="comfortable"
      itemId={it.id}
      data-key={it.id}
      badge={conflicts ? (
        <span data-merge-check="conflicts" title={conflicts.conflicts.join("\n")}>
          <Badge level="failed">{mergeCheckLabel(conflicts)}</Badge>
        </span>
      ) : (
        <StatusBadge state={it.item_phase} />
      )}
      title={it.title ?? t("item.untitled")}
      titleRaw={it.title !== null}
      href={itemPath(it.id)}
      why={
        <>
          {it.rank_reason !== undefined && <span data-rank><Badge level={it.held ? "held" : undefined}>{it.rank_reason}</Badge></span>}
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
            // Below sm the reason wraps onto as many lines as it needs; from sm up it is one line cut with an ellipsis.
            <span data-need title={reason} className="min-w-0 flex-1 basis-40 break-words sm:truncate">
              {toNeed ? <Link href={toNeed} className={cn("sm:truncate", BLOCK_LINK_CLASS)}>{reason}</Link> : reason}
            </span>
          )}
        </>
      }
      details={it.change_ref !== null && <span className="shrink-0 tabular-nums">#{it.change_ref}</span>}
      menu={<RowActions it={it} cmd={cmd} inlineErrors={false} />}
      second={errors.length > 0 && (
        <div data-row-error className="flex min-w-0 flex-col gap-1">
          {errors.map((text) => <OutcomeText key={text} outcome={{ tone: "error", text }} />)}
        </div>
      )}
    />
  );
}

/**
 * The Needs you rows as one compact list per group: the waiting items under Merge, Approve, Answer or fix, then the
 * system actions (`checks`, each open alarm its own row) under Check, in that order; no group, no heading, for no row.
 */
export function NeedsList({ items, checks = [] }: { items: readonly Item[]; checks?: readonly SystemAction[] }) {
  const groups = GROUPS.map(([group, title]) => ({ title: t(title), rows: items.filter((it) => needGroup(it) === group).map((it) => <WorkRow key={it.id} it={it} />) }))
    .concat({ title: t("needs.groupCheck"), rows: checks.map((a, i) => <CheckRow key={`${a.code}:${i}`} action={a} />) })
    .filter((g) => g.rows.length > 0);
  return (
    <div className="space-y-3">
      {groups.map((g) => (
        <div key={g.title} className="space-y-1">
          <h3 className={SUB_TITLE}>{g.title}</h3>
          <ul aria-label={g.title} className="divide-y divide-border rounded-control border border-border">
            {g.rows}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** The time of a held ask's "Held until HH:MM" rank reason; null when the ask is not held. */
const heldTime = (it: Item): string | null => (it.held ? /^Held until (.+)$/.exec(it.rank_reason ?? "")?.[1] ?? null : null);

/** The merge's risk badge: its stored verdict (failed, reverted), else "Not reviewed". */
function riskOf(verdict: string | null | undefined): { key: "tasks.riskFailed" | "tasks.riskReverted" | "tasks.riskUnreviewed"; level: string | undefined } {
  if (verdict === "failed") return { key: "tasks.riskFailed", level: "failed" };
  if (verdict === "reverted") return { key: "tasks.riskReverted", level: "failed" };
  return { key: "tasks.riskUnreviewed", level: undefined };
}

type Merge = UnreviewedMerges["merges"][number];

/** One merged PR as a row: its link, its checks and review links, its risk badge (`risk`) and who merged it. */
function MergeRow({ m, risk }: { m: Merge; risk: boolean }) {
  const label = t("tasks.mergeLink", { ref: m.change_ref });
  const r = riskOf(m.check_verdict);
  return (
    <ListRow
      data-key={m.change_ref}
      title={m.review_url ? <a href={m.review_url} target="_blank" rel="noreferrer" className={cn(ROW_TITLE, "leading-6", BLOCK_LINK_CLASS)}>{label}</a> : <span className={ROW_TITLE}>{label}</span>}
      details={
        <>
          {risk && <span data-risk><Badge level={r.level}>{t(r.key)}</Badge></span>}
          {m.checks_url && <a href={m.checks_url} target="_blank" rel="noreferrer" className={LINK_CLASS}>{t("tasks.checksLink")}</a>}
          {m.review_url && <a href={m.review_url} target="_blank" rel="noreferrer" className={LINK_CLASS}>{t("tasks.reviewLink")}</a>}
          {m.project && <span>{m.project}</span>}
        </>
      }
    />
  );
}

const MergeList = ({ merges, title, risk }: { merges: readonly Merge[]; title: string; risk: boolean }) => (
  <Card title={title} count={merges.length}>
    <ul aria-label={title} className="divide-y divide-border rounded-control border border-border">
      {merges.map((m) => <MergeRow key={`${m.project}:${m.change_ref}`} m={m} risk={risk} />)}
    </ul>
  </Card>
);

/**
 * The merged-without-you and worth-sampling cards (design 09-dashboard-tasks): the PRs that merged with no work item.
 * The first lists those since the owner's last look (this browser's local storage; a first visit the last 7 days); the
 * second all of them, failed or reverted first, then newest first. A merge is urgent: no review time holds it.
 * The last look is read once at mount and stored then, so these cards keep their rows while the page is open.
 */
function MergeCards() {
  const merges = useApi<UnreviewedMerges>(API.unreviewedMerges, 30_000).data?.merges;
  const [since] = useState(() => lastLook(Date.now()));
  useEffect(() => markLook(Date.now()), []);
  if (!merges || merges.length === 0) return null;
  const fresh = merges.filter((m) => Date.parse(m.recorded_at) > since);
  const bad = (m: Merge) => (m.check_verdict === "failed" || m.check_verdict === "reverted" ? 0 : 1);
  // Array.sort is stable: the API's newest-first order holds within each verdict.
  const sample = [...merges].sort((a, b) => bad(a) - bad(b));
  return (
    <>
      {fresh.length > 0 && <MergeList merges={fresh} title={t("tasks.mergedWithoutYou")} risk={false} />}
      <MergeList merges={sample} title={t("tasks.worthSampling")} risk />
    </>
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
  const held = needs.filter((it) => it.held === true);
  const count = needs.length - held.length + checks.length;
  const until = held.map(heldTime).find((x) => x !== null);
  return (
    <>
      {linked !== null && needs.length + checks.length > 0 && (
        <Card title={t("page.needs")} count={count}>
          {held.length > 0 && until && <p className="mb-3 text-sm text-text-2">{t("tasks.heldUntil", { count: held.length, time: until })}</p>}
          <NeedsList items={needs} checks={checks} />
        </Card>
      )}
      {project === null && <MergeCards />}
      {status}
    </>
  );
}
