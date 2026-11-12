import type { ReactNode } from "react";
import { cn } from "../../lib/cn.js";
import { toneOf } from "./parts.js";

// Status and message pieces: StatusBadge, Notice, EmptyState, Kbd and PageHeader. Colours come from the pill
// tokens; the level colours are the one map in parts.tsx.

export type BadgeSize = "sm" | "md";

/** A level's name in its status colour (the colour comes from LEVEL_TONE, so it matches Badge); a level with no tone is neutral. */
export function StatusBadge({ level, size = "md", children }: { level?: string | undefined; size?: BadgeSize; children: ReactNode }) {
  return (
    <span
      data-level={level}
      className={cn(
        "inline-flex items-center gap-1 rounded-pill font-medium whitespace-nowrap",
        size === "sm" ? "px-2 py-0.5 text-xs" : "px-2.5 py-1 text-sm",
        toneOf(level),
      )}
    >
      <span aria-hidden className="size-1.5 rounded-pill bg-current" />
      {children}
    </span>
  );
}

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

/** What a list shows when it has nothing: a title, an optional explanation and an optional action (a button or link). */
export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-control border border-dashed border-border-strong px-4 py-6 text-center">
      <p className="text-sm font-semibold">{title}</p>
      {children && <p className="mx-auto mt-1 max-w-prose text-sm text-pretty text-text-2">{children}</p>}
      {action && <div className="mt-3 flex justify-center">{action}</div>}
    </div>
  );
}

/** A keyboard key, as in "press <Kbd>Esc</Kbd>". */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded-control border border-border-strong bg-surface-2 px-1.5 py-0.5 font-sans text-xs text-text-1">{children}</kbd>;
}

/** A page's title (the one h1), an optional description under it and optional actions at the end; the actions drop below the title when narrow. */
export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-4 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
      <div className="min-w-0">
        <h1 className="text-balance text-lg font-semibold">{title}</h1>
        {description && <p className="mt-1 text-sm text-pretty text-text-2">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
