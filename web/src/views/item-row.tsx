import { Copy } from "lucide-react";
import type { KeyboardEventHandler, ReactNode, Ref } from "react";
import { copyToClipboard } from "../components/ui/copy.js";
import { announceStatus } from "../components/ui/dialog.js";
import { LINK_CLASS, ROW_LINK_CLASS } from "../components/ui/link-style.js";
import { ROW_TITLE } from "../components/ui/list-row.js";
import { type MenuItem, OverflowMenu } from "../components/ui/menu.js";
import { EmptyState } from "../components/ui/notice.js";
import { Table, Td, Tr } from "../components/ui/parts.js";
import { t } from "../i18n/index.js";
import { cn } from "../lib/cn.js";
import { Link } from "../nav.js";

// The one row of every list of work items (design 09-dashboard-tasks, 09-dashboard-system, 09-dashboard-item): Tasks,
// the Needs you rows, Work (its table and its tree), Runners' running runs and the item page's Runs. The slots come in
// one order: title (the link to the item) · StatusBadge · why it is in this state · project · worker · age · one
// primary action · "⋯" menu. The title comes first (design-system/patterns.md "List rows"), so the titles of a list
// start on one left edge whatever badge a row has (2026-11-24, the owner's alignment review). A second line shows only for "held behind X" or an error. A raw ID is never row text:
// Copy ID in the "⋯" menu is the way to it.

/** compact (Work, Runners) or comfortable (Tasks): they differ in spacing only. */
export type RowVariant = "compact" | "comfortable";

/** Each variant's spacing classes, per layout; nothing else differs between the variants. */
export const ROW_SPACE: Readonly<Record<"list" | "tree", Readonly<Record<RowVariant, string>>>> = {
  list: { compact: "gap-x-2 px-3 py-1.5", comfortable: "gap-x-3 p-3" },
  tree: { compact: "gap-x-2 py-1", comfortable: "gap-x-3 py-2" },
};

/** The "⋯" menu's Copy ID: writes `id` to the clipboard and says so; with no clipboard it does nothing. */
export const copyIdItem = (id: string): MenuItem => ({
  label: t("copy.id"),
  icon: Copy,
  onSelect: () => {
    void copyToClipboard(id).then((ok) => ok && announceStatus(t("copy.done")));
  },
});

export interface ItemRowSlots {
  /** The StatusBadge (or what stands for it, such as a task's overdue badge). */
  badge?: ReactNode;
  /** The title's text; it links to `href`, or is plain text with none (an unbuilt task). */
  title: string;
  href?: string | null | undefined;
  /** The title is stored text that may quote names as written (`data-raw`, the responsive check's raw-name rule skips it). */
  titleRaw?: boolean;
  /** Classes added to the title (a late or done task's colour). */
  titleClassName?: string | undefined;
  /** Shown in place of the title while the row edits it (a task's edit form). */
  editing?: ReactNode;
  why?: ReactNode;
  project?: ReactNode;
  /** Further details, after the project (a task's minutes, priority, recurrence). */
  details?: ReactNode;
  worker?: ReactNode;
  age?: ReactNode;
  /** The one primary action, beside the menu. */
  action?: ReactNode;
  /** A ready "⋯" menu (a waiting item's commands); else one is built from `menuItems`, then Copy ID for `copyId`. */
  menu?: ReactNode;
  menuLabel?: string | undefined;
  menuItems?: readonly MenuItem[] | undefined;
  copyId?: string | undefined;
  /** The second line: "held behind X" or an error, nothing else. */
  second?: ReactNode;
}

type Slot = "badge" | "title" | "why" | "project" | "worker" | "age" | "actions";

/** The row's "⋯" menu: the given one, else `menuItems` then Copy ID; nothing when it has no item. */
function rowMenu(s: ItemRowSlots): ReactNode {
  if (s.menu) return s.menu;
  const items = [...(s.menuItems ?? []), ...(s.copyId ? [copyIdItem(s.copyId)] : [])];
  return items.length > 0 ? <OverflowMenu label={s.menuLabel ?? t("commands.more")} items={items} /> : null;
}

/**
 * The title: `data-row-title` in a list or tree row, one line (the responsive check's title-wrap rule); in a table
 * `data-cell-title`, as a table's title column wraps (a card's too). `link` is the link's style: LINK_CLASS, or
 * ROW_LINK_CLASS in a list row.
 */
function Title({ s, className, cell = false, link = LINK_CLASS }: { s: ItemRowSlots; className: string; cell?: boolean; link?: string }) {
  if (s.editing) return <>{s.editing}</>;
  const mark = cell ? { "data-cell-title": "" } : { "data-row-title": "" };
  if (s.href) {
    return (
      <Link href={s.href} title={s.title} {...mark} data-raw={s.titleRaw ? "" : undefined} className={cn(link, className, s.titleClassName)}>
        {s.title}
      </Link>
    );
  }
  return <p title={s.title} {...mark} className={cn(className, s.titleClassName)}>{s.title}</p>;
}

/**
 * A list row's title: one 32px line (the 32px controls' height), the text centred in it, in the row title weight. It
 * takes the free width. Below `sm` its base width is its text's: a short title shares its line with the badge, a long
 * one takes the line to itself (cut with an ellipsis) and the badge starts the next. From `sm` up it starts at 160px.
 */
export const LIST_TITLE = "min-h-8 min-w-0 flex-1 basis-auto font-medium leading-8 text-text-1 sm:basis-40";

const AGE = "text-xs whitespace-nowrap tabular-nums text-text-2";

type DataAttrs = { [data: `data-${string}`]: string | undefined };

interface ListProps extends ItemRowSlots {
  layout?: "list";
  variant: RowVariant;
  /** The work item's ID, as `data-item-id`; none for an unbuilt task. */
  itemId?: string | undefined;
  /** A control before the badge (a task's Checkbox): not an item field. */
  lead?: ReactNode;
  /** Classes for the whole row (a done task's text-2, focus ring, sub-task indent). */
  className?: string;
  /** Forms and dialogs the row opens, under its lines. */
  children?: ReactNode;
  ref?: Ref<HTMLLIElement>;
  tabIndex?: number | undefined;
  onKeyDown?: KeyboardEventHandler<HTMLLIElement>;
}

interface TreeProps extends ItemRowSlots {
  layout: "tree";
  variant: RowVariant;
  itemId: string;
  className?: string;
}

interface TableProps extends ItemRowSlots {
  layout: "table";
  itemId: string;
  /** The columns the table shows, in slot order (ItemTable leaves out one that is empty in every row). */
  columns: readonly Slot[];
}

export type ItemRowProps = (ListProps | TreeProps | TableProps) & DataAttrs;

/**
 * One row of a list of work items. `list` (default) is an `li` of a bordered list; `tree` the content of a Work tree
 * row (its chevron and indentation stay outside); `table` a Table row, one cell per slot (ItemTable).
 */
export function ItemRow(props: ItemRowProps) {
  if (props.layout === "table") return <TableRow {...props} />;
  if (props.layout === "tree") return <TreeRow {...props} />;
  return <ListRowOf {...props} />;
}

/** Splits the slot props from the data attributes the row element carries. */
function dataOf(props: object): DataAttrs {
  return Object.fromEntries(Object.entries(props).filter(([k]) => k.startsWith("data-"))) as DataAttrs;
}

function ListRowOf(props: ListProps & DataAttrs) {
  const { variant, itemId, lead, className, children, ref, tabIndex, onKeyDown } = props;
  const menu = rowMenu(props);
  return (
    <li ref={ref} tabIndex={tabIndex} onKeyDown={onKeyDown} {...dataOf(props)} data-item-row={variant} data-item-id={itemId} className={cn("flex items-start", ROW_SPACE.list[variant], className)}>
      {lead}
      <div className="min-w-0 flex-1 space-y-1">
        {/* One line: the slots are its children, so a slot's parts sit beside the badge (small muted text but the title).
            It is also the row's details (`data-details`, as a ListRow's), where the due time and the list are read. */}
        <div data-row-line data-details className={cn("flex min-w-0 flex-wrap items-center gap-y-1 text-xs text-pretty text-text-2", ROW_SPACE.list[variant].split(" ")[0])}>
          {/* A 32px line, text centred in it: the same height and centre as the Checkbox, the action and the menu, so
              they share one centre line, also when the details wrap under it (design 09-dashboard-tasks). */}
          <Title s={props} link={ROW_LINK_CLASS} className={cn(ROW_TITLE, LIST_TITLE)} />
          {props.badge && <span data-row-badge className="flex min-h-8 shrink-0 items-center gap-1">{props.badge}</span>}
          {/* Below `sm` the title and the badge keep the first line to themselves; the details start the next one. */}
          {(props.why || props.project || props.details || props.worker || props.age || props.action) && <span aria-hidden className="basis-full sm:hidden" />}
          {props.why}
          {props.project && <span data-row-project className="break-all">{props.project}</span>}
          {props.details}
          {props.worker}
          {props.age && <span data-row-age className={AGE}>{props.age}</span>}
          {props.action && <span data-row-action className="shrink-0">{props.action}</span>}
        </div>
        {props.second && <div data-row-second className="text-xs text-pretty break-words">{props.second}</div>}
        {children}
      </div>
      {menu && <div data-row-menu className="flex shrink-0 items-start">{menu}</div>}
    </li>
  );
}

function TreeRow(props: TreeProps & DataAttrs) {
  const menu = rowMenu(props);
  return (
    // One centre line: the 32px title line (it takes the free width and is cut with an ellipsis), the badge, the meta
    // (why, run, worker, PR, then the age, always the last: all text-xs text-2) and the 32px "⋯" at the end are centred
    // on it. At phone width a short title and its badge share the first line (a long title takes it alone, the badge
    // under it) and the meta takes its own line under them;
    // the "⋯" stays on the first line.
    <div {...dataOf(props)} data-item-row={props.variant} data-item-id={props.itemId} className={cn("flex min-w-0 flex-1 items-start", ROW_SPACE.tree[props.variant], props.className)}>
      <div className={cn("flex min-w-0 flex-1 flex-wrap items-center gap-y-1", ROW_SPACE.tree[props.variant].split(" ")[0])}>
        <Title s={props} className="min-h-8 min-w-0 flex-1 basis-auto truncate leading-8 font-medium sm:basis-40" />
        {props.badge && <span data-row-badge className="flex min-h-8 shrink-0 items-center">{props.badge}</span>}
        {/* At phone width the why and the worker take their own line. */}
        <span className="flex min-w-0 basis-full flex-wrap items-center gap-x-2 *:min-w-0 text-xs wrap-anywhere text-text-2 sm:basis-auto">
          {props.why}
          {props.project}
          {props.worker}
        </span>
        {/* The PR link: a 24px line with its text centred, so it sits on the row's centre line like the age. */}
        {props.action && <span data-row-action className="flex items-center text-xs leading-6 tabular-nums text-text-2">{props.action}</span>}
        {props.age && <span className={AGE}>{props.age}</span>}
        {props.second && <span data-row-second className="basis-full text-xs text-text-2">{props.second}</span>}
      </div>
      {menu && <span data-row-menu className="shrink-0">{menu}</span>}
    </div>
  );
}

function TableRow(props: TableProps & DataAttrs) {
  const menu = rowMenu(props);
  const cell: Record<Slot, () => ReactNode> = {
    badge: () => <Td key="badge">{props.badge}</Td>,
    // wrap-anywhere, not break-words: only it lowers the column's min-content width, so an unbroken word in the title
    // or an error's Details cannot push the actions column past the window (design 09-dashboard-item-runs, 2026-11-24).
    title: () => (
      <Td key="title" className="max-w-md min-w-40">
        <Title s={props} cell className="max-w-full font-medium wrap-anywhere" />
        {props.second && <div data-row-second className="mt-1 text-xs wrap-anywhere">{props.second}</div>}
      </Td>
    ),
    why: () => <Td key="why" className="text-text-2">{props.why}</Td>,
    project: () => <Td key="project">{props.project}</Td>,
    worker: () => <Td key="worker">{props.worker}</Td>,
    age: () => <Td key="age" className="tabular-nums whitespace-nowrap">{props.age}</Td>,
    actions: () => (
      <Td key="actions" className="whitespace-nowrap">
        {props.action || menu ? (
          <span className="inline-flex items-center gap-2">
            {props.action && <span data-row-action className="tabular-nums">{props.action}</span>}
            {menu && <span data-row-menu>{menu}</span>}
          </span>
        ) : undefined}
      </Td>
    ),
  };
  return <Tr {...dataOf(props)} data-item-id={props.itemId}>{props.columns.map((c) => cell[c]())}</Tr>;
}

/** One ItemTable row: its slots, its work item's ID, its React key and any data attributes. */
export type ItemTableRow = ItemRowSlots & DataAttrs & { key: string; itemId: string };

const SLOTS: readonly Slot[] = ["badge", "title", "why", "project", "worker", "age", "actions"];
const has = (r: ItemTableRow, s: Slot): boolean => s === "title" || (s === "actions" ? !!(r.action || r.menu || r.menuItems?.length || r.copyId) : !!r[s]);

/**
 * A Table of ItemRows (compact): one column per slot in the row order, the action and the "⋯" menu sharing the last;
 * a column empty in every row is left out. Below `sm` the Table shows one card per row. `head` names each column;
 * with no row it shows `empty`.
 */
export function ItemTable({ label, head, rows, empty }: { label: string; head: Readonly<Record<Slot, string>>; rows: readonly ItemTableRow[]; empty: ReactNode }) {
  if (rows.length === 0) return <EmptyState title={empty} />;
  const columns = SLOTS.filter((s) => rows.some((r) => has(r, s)));
  return (
    <Table label={label} head={columns.map((c) => head[c])}>
      {rows.map(({ key, ...r }) => <ItemRow key={key} layout="table" columns={columns} {...r} />)}
    </Table>
  );
}
