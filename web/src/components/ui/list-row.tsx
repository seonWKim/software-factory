import type { LiHTMLAttributes, ReactNode, Ref } from "react";
import { cn } from "../../lib/cn.js";

/** A list row's title text: one line, cut with an ellipsis; give the element `title` with the full text. */
export const ROW_TITLE = "block truncate text-sm";

/**
 * One row of a bordered list (the Tasks page's Needs you, date groups and Done): an optional leading control (a
 * checkbox), the title on one full-width line, the details line under it (state chips, dates, projects, reason), any
 * extra content (a form, an error) below, and at the right the row's one visible `action` (a small Button, the next
 * step, as ItemRow's primary action; optional) then its "⋯" menu, which holds the row's other actions. The action, the
 * menu and the 32px leading control are pulled up 6px so their centres are level with the title's first 20px line.
 * Below `sm` the action takes a line of its own under the row's content, so the title keeps the row's width; the ⋯
 * stays at the top right.
 */
export function ListRow({ leading, title, details, action, menu, children, className, ...li }: Omit<LiHTMLAttributes<HTMLLIElement>, "title"> & {
  leading?: ReactNode;
  title: ReactNode;
  details?: ReactNode;
  action?: ReactNode;
  menu?: ReactNode;
  children?: ReactNode;
  ref?: Ref<HTMLLIElement>;
}) {
  return (
    <li data-list-row {...li} className={cn("flex items-start gap-3 p-3", Boolean(action) && "max-sm:flex-wrap max-sm:gap-y-2", className)}>
      {leading && <div data-row-leading className="-mt-1.5 flex shrink-0 items-start">{leading}</div>}
      <div className="min-w-0 flex-1 space-y-1">
        {title}
        {details && <div data-details className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-pretty text-text-2">{details}</div>}
        {children}
      </div>
      {action && <div data-row-action className="-mt-1.5 flex min-h-8 shrink-0 items-center max-sm:order-last max-sm:mt-0 max-sm:min-h-0 max-sm:basis-full">{action}</div>}
      {menu && <div data-row-menu className="-mt-1.5 flex shrink-0 items-start">{menu}</div>}
    </li>
  );
}
