import type { ReactNode } from "react";
import { type Tone, stateLabel, stateTone } from "../../../../src/shared/states.js";
import { cn } from "../../lib/cn.js";

// The one badge: a pill with a dot in a tone's colour. A state's tone comes from the one state table
// (src/shared/states.ts); TONE_CLASS is the one map from a tone to the pill tokens (tests/design-system.test.ts checks
// every pair here for contrast).

/** A tone's token classes. */
export const TONE_CLASS: Readonly<Record<Tone, string>> = {
  ok: "bg-pill-ok-bg text-pill-ok-fg",
  warn: "bg-pill-warn-bg text-pill-warn-fg",
  bad: "bg-pill-bad-bg text-pill-bad-fg",
  info: "bg-pill-info-bg text-pill-info-fg",
  neutral: "bg-surface-2 text-text-1",
};

/** The pill: a dot and the text, in a tone. */
function Pill({ tone, children, ...data }: { tone: Tone; children: ReactNode; "data-level"?: string | undefined; "data-status"?: string }) {
  return (
    <span {...data} className={cn("inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-xs font-medium whitespace-nowrap", TONE_CLASS[tone])}>
      <span aria-hidden className="size-1.5 rounded-pill bg-current" />
      {children}
    </span>
  );
}

/** Any short text in a pill in the tone of `level`, a state table key; an unknown or missing one is neutral. */
export function Badge({ level, children }: { level?: string | undefined; children: ReactNode }) {
  return <Pill tone={stateTone(level)} data-level={level}>{children}</Pill>;
}

/**
 * An item's, a run's or a worker's state as a pill: the state table's label (or `children`, words that say more, such
 * as where a Merge is) in its tone, with `data-status` set to the state key (and `data-level`, as Badge, for the
 * selectors that find a pill by it).
 */
export function StatusBadge({ state, children }: { state: string; children?: ReactNode }) {
  return <Pill tone={stateTone(state)} data-status={state} data-level={state}>{children ?? stateLabel(state)}</Pill>;
}
