// Hooks (RFC 0015 §8): a discovered, time-budgeted check at a fixed point that may veto with a reason or add a
// note. A hook never approves: it runs only after the guards allowed the action, and its result can only refuse.
// Each one is `src/<component>/hooks/<name>/<name>.hook.ts`. Off until the owner enables it (§15.2). Pure: no I/O.

/**
 * The points a pack check runs at (design 04-pre-push-gates.md, issue #494), all in the implement run: before and
 * after each agent step, on each Edit or Write the agent asks for, and before the pre-push gates. Pack checks only.
 */
export const PACK_CHECK_POINTS = ["before_agent", "on_tool_call", "before_finish", "after_agent"] as const;
export type PackCheckPoint = (typeof PACK_CHECK_POINTS)[number];

export const HOOK_POINTS = ["before_merge", "before_run", "before_delivery", ...PACK_CHECK_POINTS] as const;
export type HookPoint = (typeof HOOK_POINTS)[number];
/**
 * Points no caller runs a `*.hook.ts` at: startup refuses a hook enabled at one. `before_delivery` has no caller
 * yet (remove it here when its caller lands); the pack check points run pack checks only.
 */
export const UNCALLED_HOOK_POINTS: readonly HookPoint[] = ["before_delivery", ...PACK_CHECK_POINTS];

/** What a hook sees: ids only, as on the bus. `at` is the tick time the caller decides at. */
export interface HookInput {
  readonly point: HookPoint;
  /** The actor the action is on (work item, run, delivery batch). */
  readonly subject: string;
  readonly project_id: string;
  readonly passport_id: string | null;
  readonly at: string;
}

export type HookVerdict = { readonly kind: "pass" } | { readonly kind: "veto"; readonly reason: string } | { readonly kind: "annotate"; readonly note: string };

export interface HookDescriptor {
  readonly kind: "hook";
  /** Unique; what the owner enables. */
  readonly name: string;
  readonly point: HookPoint;
  /** How long it may take; past it, it counts as a veto (`hook_timeout`). */
  readonly budget_ms: number;
  run(input: HookInput, signal: AbortSignal): Promise<HookVerdict>;
}

/** The longest budget a hook may ask for. */
export const MAX_HOOK_BUDGET_MS = 10_000;
export const HOOK_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export function defineHook(h: Omit<HookDescriptor, "kind">): HookDescriptor {
  if (!HOOK_NAME.test(h.name)) throw new Error(`hook name "${h.name}" must be kebab-case`);
  if (!(HOOK_POINTS as readonly string[]).includes(h.point)) throw new Error(`hook "${h.name}": point must be one of ${HOOK_POINTS.join(", ")}`);
  if (!Number.isInteger(h.budget_ms) || h.budget_ms < 1 || h.budget_ms > MAX_HOOK_BUDGET_MS) {
    throw new Error(`hook "${h.name}": budget_ms must be 1 to ${MAX_HOOK_BUDGET_MS}`);
  }
  return { kind: "hook", ...h };
}

/** Waits `ms`, or until `signal` aborts. The time-based tick plugin gives the real one; tests give a fake. */
export interface Timer {
  after(ms: number, signal: AbortSignal): Promise<void>;
}
