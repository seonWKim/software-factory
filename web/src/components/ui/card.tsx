import type { ReactNode } from "react";

// A page block: the surface, a 1px border, the card radius, 24px of padding (16px below `sm`) and shadow-sm, with an
// optional title, count and action. design-system/components.md "Card".

/** The section title's type role (tokens.json `type-roles.section-title`): Card's title and a CardSection's. */
export const CARD_TITLE = "text-balance text-base font-semibold";

/** The title row: the heading, the count beside it, the action at the end. Nothing when there is none of them. */
function TitleRow({ as: Heading, title, count, action, live }: { as: "h2" | "h3"; title?: string | undefined; count?: number | undefined; action?: ReactNode; live?: boolean | undefined }) {
  if (title === undefined && count === undefined && !action) return null;
  return (
    <div className="mb-4 flex flex-wrap items-baseline gap-x-2 gap-y-2">
      {title !== undefined && <Heading aria-live={live ? "polite" : undefined} className={CARD_TITLE}>{title}</Heading>}
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
      className="mt-6 min-w-0 rounded-card border border-border bg-surface p-4 shadow-sm first:mt-0 sm:p-6"
    >
      <TitleRow as="h2" title={title} count={count} action={action} live={live} />
      {children}
    </section>
  );
}

/** A titled part inside a Card (an h3 in the section title's type), with an optional count and action. Not a region of its own. */
export function CardSection({ title, count, action, children }: { title: string; count?: number | undefined; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="mt-6 min-w-0 first:mt-0">
      <TitleRow as="h3" title={title} count={count} action={action} />
      {children}
    </div>
  );
}
