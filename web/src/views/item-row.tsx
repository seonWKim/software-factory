import { Copy } from "lucide-react";
import type { KeyboardEventHandler, ReactNode, Ref } from "react";
import { copyToClipboard } from "../components/ui/copy.js";
import { announceStatus } from "../components/ui/dialog.js";
import { LINK_CLASS } from "../components/ui/link-style.js";
import { ROW_TITLE } from "../components/ui/list-row.js";
import { type MenuItem, OverflowMenu } from "../components/ui/menu.js";
import { EmptyState } from "../components/ui/notice.js";
import { Table, Td, Tr } from "../components/ui/parts.js";
import { t } from "../i18n/index.js";
import { cn } from "../lib/cn.js";
import { Link } from "../nav.js";

// The one row of every list of work items (design 09-dashboard-tasks, 09-dashboard-system, 09-dashboard-item): Tasks,
// the Needs you rows, Work (its table and its tree), Runners' running runs and the item page's Runs. The slots come in
// one order: StatusBadge · title (the link to the item) · why it is in this state · project · worker · age · one
// primary action · "⋯" menu. A second line shows only for "held behind X" or an error. A raw ID is never row text:
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
 * `data-cell-title`, as a table's title column wraps (a card's too).
 */
function Title({ s, className, cell = false }: { s: ItemRowSlots; className: string; cell?: boolean }) {
  if (s.editing) return <>{s.editing}</>;
  const mark = cell ? { "data-cell-title": "" } : { "data-row-title": "" };
  if (s.href) {
    return (
      <Link href={s.href} title={s.title} {...mark} data-raw={s.titleRaw ? "" : undefined} className={cn(LINK_CLASS, className, s.titleClassName)}>
        {s.title}
      </Link>
    );
  }
  return <p title={s.title} {...mark} className={cn(className, s.titleClassName)}>{s.title}</p>;
}

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
          {props.badge && <span data-row-badge className="flex shrink-0 items-center gap-1">{props.badge}</span>}
          <Title s={props} className={cn(ROW_TITLE, "min-w-0 flex-1 basis-40 text-text-1")} />
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
    <div {...dataOf(props)} data-item-row={props.variant} data-item-id={props.itemId} className={cn("flex min-w-0 flex-1 flex-wrap items-baseline gap-y-1", ROW_SPACE.tree[props.variant], props.className)}>
      {props.badge}
      <Title s={props} className="min-w-0 truncate font-medium" />
      {/* At phone width the why and the worker take their own line. */}
      <span className="flex min-w-0 basis-full flex-wrap gap-x-2 *:min-w-0 text-xs wrap-anywhere text-text-2 sm:basis-auto sm:text-sm">
        {props.why}
        {props.project}
        {props.worker}
      </span>
      {props.age && <span className={AGE}>{props.age}</span>}
      {props.action && <span className="text-xs tabular-nums">{props.action}</span>}
      {menu && <span data-row-menu className="self-center">{menu}</span>}
      {props.second && <span data-row-second className="basis-full text-xs text-text-2">{props.second}</span>}
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
