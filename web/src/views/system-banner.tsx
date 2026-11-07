import type { SystemAction } from "../api.js";
import { Link } from "../nav.js";
import { itemPath } from "../pages.js";
import { LINK_CLASS } from "../components/ui/link-style.js";

/**
 * Shown while the app was built from another revision than the server it talks to runs (design §9): the tab
 * holds old code, or the UI server does. Only "they differ", never which is newer. Hidden while either is unknown.
 */
export function RevisionBanner({ server, web }: { server: string | null | undefined; web: string | null }) {
  if (!server || !web || server === web) return null;
  return (
    <p role="alert" data-testid="revision-banner" className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-pretty text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
      Dashboard out of date: reload / restart <code className="font-mono">factory ui</code>
    </p>
  );
}

/** The system actions at the top of Needs you, each with the command that clears it. Nothing while there is none. */
export function SystemActions({ actions }: { actions: readonly SystemAction[] }) {
  if (actions.length === 0) return null;
  return (
    <ul aria-label="System actions" className="mb-3 space-y-1">
      {actions.map((a, i) => (
        <li key={`${a.code}:${a.work_item_id ?? i}`} data-action={a.code} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-md bg-red-50 px-3 py-2 text-sm text-red-900 dark:bg-red-950 dark:text-red-100">
          <span className="min-w-0 text-pretty">
            {a.work_item_id ? <Link href={itemPath(a.work_item_id)} className={LINK_CLASS}>{a.text}</Link> : a.text}
          </span>
          <code className="font-mono text-xs break-all">{a.command}</code>
        </li>
      ))}
    </ul>
  );
}
