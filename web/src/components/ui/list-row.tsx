import type { LiHTMLAttributes, ReactNode, Ref } from "react";
import { cn } from "../../lib/cn.js";

/** A list row's title text: one line, cut with an ellipsis; give the element `title` with the full text. */
export const ROW_TITLE = "block truncate text-sm";

/**
 * One row of a bordered list (the Tasks page's Needs you, date groups and Done): an optional leading control (a
 * checkbox), the title on one full-width line, the details line under it (state chips, dates, projects, reason), any
 * extra content (a form, an error) below, and the row's "⋯" menu at the right, which holds every action of the row. The
 * menu's 32px button and the 32px leading control are pulled up 6px so their centres are level with the title's first
 * 20px line.
 */
export function ListRow({ leading, title, details, menu, children, className, ...li }: Omit<LiHTMLAttributes<HTMLLIElement>, "title"> & {
  leading?: ReactNode;
  title: ReactNode;
  details?: ReactNode;
  menu?: ReactNode;
  children?: ReactNode;
  ref?: Ref<HTMLLIElement>;
}) {
  return (
    <li data-list-row {...li} className={cn("flex items-start gap-3 p-3", className)}>
      {leading && <div data-row-leading className="-mt-1.5 flex shrink-0 items-start">{leading}</div>}
      <div className="min-w-0 flex-1 space-y-1">
        {title}
        {details && <div data-details className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-pretty text-text-2">{details}</div>}
        {children}
      </div>
      {menu && <div data-row-menu className="-mt-1.5 flex shrink-0 items-start">{menu}</div>}
    </li>
  );
}
