import type { ReactNode } from "react";
import { cn } from "../../lib/cn.js";

// The one badge: a pill with a dot in a level's status colour. The colours are the pill tokens; LEVEL_TONE is the
// one map from a level to them (tests/design-system.test.ts checks every pair here for contrast).

/** The tone of a level with no colour of its own. */
const NEUTRAL = "bg-surface-2 text-text-1";

/** The one status colour map: a level name to its token classes. */
export const LEVEL_TONE: Record<string, string> = {
  ready_to_merge: "bg-pill-ok-bg text-pill-ok-fg",
  needs_approval: "bg-pill-warn-bg text-pill-warn-fg",
  needs_you: "bg-pill-bad-bg text-pill-bad-fg",
  needs_triage: "bg-pill-warn-bg text-pill-warn-fg",
  stuck: "bg-pill-bad-bg text-pill-bad-fg",
  running: "bg-pill-info-bg text-pill-info-fg",
  blocked_by_task: NEUTRAL,
};

/** A level's name (or any short state) in a pill in the level's status colour; a level with no tone is neutral. */
export function Badge({ level, children }: { level?: string | undefined; children: ReactNode }) {
  return (
    <span
      data-level={level}
      className={cn(
        "inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        (level && LEVEL_TONE[level]) ?? NEUTRAL,
      )}
    >
      <span aria-hidden className="size-1.5 rounded-pill bg-current" />
      {children}
    </span>
  );
}
