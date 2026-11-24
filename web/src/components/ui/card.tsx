import type { ReactNode } from "react";
import { cn } from "../../lib/cn.js";

// A page block: the surface, a 1px border, the card radius, 24px of padding (16px below `sm`) and shadow-sm, with an
// optional title, count and action. design-system/components.md "Card".

/** The section title's type role (tokens.json `type-roles.section-title`): Card's title and a CardSection's. */
export const CARD_TITLE = "text-balance text-base font-semibold";

/** A page block's padding: 24px, 16px below `sm`. Card's, and any other page-level box's (the item page's decision card). */
export const CARD_PAD = "p-4 sm:p-6";

/**
 * A block's intro paragraph, right under its title row (16px above it from the title row, 16px below it to the
 * content): `text-sm` `text-2` at the reading width, the PageHeader description's type. Every card intro uses it.
 */
export const CARD_INTRO = "mb-4 max-w-prose text-sm text-pretty text-text-2";

/** A sub-group's heading (an h3): a CardSection's title, and every other h3 on a page (a day, a group of rows). */
export const SUB_TITLE = "text-xs font-medium text-text-2";

/** The title row: the heading, the count beside it, the action at the end. Nothing when there is none of them. */
function TitleRow({ as: Heading, title, count, action, live }: { as: "h2" | "h3"; title?: string | undefined; count?: number | undefined; action?: ReactNode; live?: boolean | undefined }) {
  if (title === undefined && count === undefined && !action) return null;
  return (
    <div className={cn("flex flex-wrap items-baseline gap-x-2 gap-y-2", Heading === "h2" ? "mb-4" : "mb-2")}>
      {title !== undefined && <Heading aria-live={live ? "polite" : undefined} className={Heading === "h2" ? CARD_TITLE : SUB_TITLE}>{title}</Heading>}
      {count !== undefined && <span className="text-sm text-text-3 tabular-nums">{count}</span>}
      {action && <div className="ml-auto">{action}</div>}
    </div>
  );
}

/**
 * A titled block on a page: a region named by its `label`, else by its `title` (an h2). The count shows beside the
 * title; the action sits at the end of the title row. `live` announces a title that changes (the calendar's period).
 */
export function Card({ title, label, count, action, id, live, children }: { title?: string; label?: string; count?: number | undefined; action?: ReactNode; id?: string; live?: boolean; children: ReactNode }) {
  return (
    <section
      id={id}
      aria-label={label ?? title}
      className={cn("mt-6 min-w-0 rounded-card border border-border bg-surface shadow-sm first:mt-0", CARD_PAD)}
    >
      <TitleRow as="h2" title={title} count={count} action={action} live={live} />
      {children}
    </section>
  );
}

/** A titled part inside a Card (an h3 in the sub-group type, SUB_TITLE), with an optional count and action. Not a region of its own. */
export function CardSection({ title, count, action, children }: { title: string; count?: number | undefined; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="mt-6 min-w-0 first:mt-0">
      <TitleRow as="h3" title={title} count={count} action={action} />
      {children}
    </div>
  );
}
