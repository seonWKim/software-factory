import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn.js";

// Message pieces: Notice, EmptyState, Kbd and PageHeader. Colours come from the pill tokens; the badge is badge.tsx.

export type NoticeTone = "info" | "ok" | "warn" | "bad";

const NOTICE_TONE: Record<NoticeTone, string> = {
  info: "bg-pill-info-bg text-pill-info-fg",
  ok: "bg-pill-ok-bg text-pill-ok-fg",
  warn: "bg-pill-warn-bg text-pill-warn-fg",
  bad: "bg-pill-bad-bg text-pill-bad-fg",
};

/** An inline message in a tone, with an optional bold title. `warn` and `bad` are announced at once (role alert), the others politely (status). */
export function Notice({ tone = "info", title, children }: { tone?: NoticeTone; title?: string; children: ReactNode }) {
  return (
    <div role={tone === "warn" || tone === "bad" ? "alert" : "status"} data-tone={tone} className={cn("rounded-control px-3 py-2 text-sm", NOTICE_TONE[tone])}>
      {title && <p className="font-semibold">{title}</p>}
      <div className="text-pretty">{children}</div>
    </div>
  );
}

/** EmptyState's box: dashed, centred. A list whose action must keep its place in the tree (Plugins' Import) draws it itself. */
export const EMPTY_BOX = "flex flex-col items-center rounded-box border border-dashed border-border-strong px-4 py-8 text-center";

/** What a list shows when it has nothing, centred: an optional icon, a title, an optional description and an optional action (a button or link). */
export function EmptyState({ icon: Icon, title, description, action }: { icon?: LucideIcon; title: ReactNode; description?: ReactNode; action?: ReactNode }) {
  return (
    <div data-empty className={EMPTY_BOX}>
      {Icon && <Icon aria-hidden className="mb-3 size-6 text-text-3" />}
      <p className="text-sm font-semibold text-pretty">{title}</p>
      {description && <p className="mt-1 max-w-prose text-sm text-pretty text-text-2">{description}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

/** A keyboard key, as in "press <Kbd>Esc</Kbd>". */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded-control border border-border-strong bg-surface-2 px-1.5 py-0.5 font-sans text-xs text-text-1">{children}</kbd>;
}

/**
 * A page's title (the one h1), an optional description under it and optional actions at the end, the primary
 * action last; the actions drop below the title when narrow.
 */
export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
      <div className="min-w-0">
        <h1 className="text-balance text-xl font-semibold">{title}</h1>
        {description && <p className="mt-1 max-w-prose text-sm text-pretty text-text-2">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
