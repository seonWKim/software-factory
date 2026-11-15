// What a waiting item's row says (design §9): the reason in plain words, where to act, and the command to type.
// One function for the classic page (pages.ts) and the items API (api.ts), so both give the same reason for the
// same item. Store reads only, no forge call: the PR link is the item's stored change_url.

import { LOCAL_SOURCE } from "../core/local-merge.js";
import { parseNeedsHuman } from "../core/outputs.js";
import { AGENT_NEEDS_HUMAN } from "../core/policy.js";
import { RECURRING_FAILURE, type Run, type WorkItem } from "../core/types.js";
import type { FactoryStore } from "../interfaces/factory-store.js";
import { type HeldFailure, heldFailureText } from "./why.js";
import type { Withholder } from "./withhold.js";

/** What a waiting item's row says. `reason` is plain text (the caller escapes it for HTML). */
export interface Need {
  reason: string;
  url: string;
  label: string;
  command: string | null;
}

/** What needOf reads: the store for a failed run's code, and the egress scan of free text. */
export interface NeedCtx {
  store: Pick<FactoryStore, "listRuns">;
  /** The value through the Withholder (cut to `max`), as plain text. */
  text(value: string, opts?: { channel?: "run_outcome"; max?: number }): Promise<string>;
}

/** needOf's context from the store and the page's Withholder. */
export function needCtx(store: NeedCtx["store"], w: Pick<Withholder, "plain">): NeedCtx {
  return { store, text: async (v, o) => (await w.plain(v, o)).text };
}

/** A ready-to-merge item's merge check: its state and how many files conflict. */
export interface MergeCheckNeed {
  state: "mergeable" | "checking" | "conflicts";
  conflicts: number;
}

/** blocked_reason values with no command, in plain words. Anything else unknown is shown with spaces for `_`. */
const PLAIN_REASONS: Record<string, string> = {
  max_loops: "review found bugs too many times",
  merge_conflict_pending: "merge conflict",
};

/** The merge check in words: "mergeable", "checking", or the conflict count. */
function mergeText(m: MergeCheckNeed): string {
  if (m.state === "mergeable") return "mergeable";
  if (m.state === "checking") return "merge check running";
  return `${m.conflicts} conflicting ${m.conflicts === 1 ? "file" : "files"}`;
}

/** The item's need. `check` is the merge check of a ready-to-merge item, when the caller has it. */
export async function needOf(c: NeedCtx, it: WorkItem, check: MergeCheckNeed | null = null): Promise<Need> {
  const issue = { url: it.source.link, label: "issue" };
  const reason = it.blocked_reason ?? "";
  const stored = (url: string | null, label: string) => (url === null ? issue : { url, label });
  if (reason === "spec_pending") {
    return { reason: "spec ready", ...stored(it.spec_comment_url, "spec comment"), command: "/approve or /reject <reason>" };
  }
  if (reason === "merge_pending") {
    // The Merge button merges it (design §9); a local item also merges with `factory merge <id>`.
    const local = it.source.type === LOCAL_SOURCE;
    return {
      reason: check ? mergeText(check) : "ready to merge",
      ...(local ? issue : stored(it.change_url, `PR #${it.change_ref}`)),
      command: local ? `factory merge ${it.id}` : null,
    };
  }
  const failed = reason.match(/^run_failed:[a-z]+:(.+)$/)?.[1] ?? (reason === "max_attempts" || reason === "max_restart" || reason === "repeated_failure" ? await latestErrorCode(c.store, it) : null);
  if (failed !== null) {
    const code = await c.text(failed, { channel: "run_outcome", max: 80 });
    return { reason: `failed: ${code}`, ...stored(it.failure_comment_url, "failure comment"), command: "/retry" };
  }
  if (reason === RECURRING_FAILURE) {
    return { reason: heldFailureText(await heldFailureOf(c, it)), ...issue, command: "/retry" };
  }
  if (reason === AGENT_NEEDS_HUMAN) {
    const ask = await latestAsk(c.store, it);
    if (ask) return { reason: await c.text(ask.question, { max: 200 }), ...stored(it.failure_comment_url, "Answer"), command: null };
  }
  // A null reason gets fixed words, never an empty or "no reason" text.
  if (reason === "") return { reason: "waiting for a person", ...issue, command: null };
  // Scan the stored reason itself: the reworded text could hide a secret from the scanner.
  const shown = await c.text(reason);
  const plain = shown !== reason ? shown : (PLAIN_REASONS[reason] ?? reason.replace(/[_:]+/g, " "));
  return { reason: plain, ...issue, command: null };
}

/** The item's latest failed run's outcome, or null when it has none. */
function lastFailure(runs: readonly Run[]): HeldFailure["outcome"] | null {
  const failed = runs.filter((r) => r.outcome?.status === "failed");
  const last = failed.reduce<Run | null>((a, r) => (a === null || (r.finished_at ?? r.updated_at) >= (a.finished_at ?? a.updated_at) ? r : a), null);
  return last?.outcome?.status === "failed" ? last.outcome : null;
}

/** The error code of the item's latest failed run ("unknown" when it has none). */
async function latestErrorCode(store: NeedCtx["store"], it: WorkItem): Promise<string> {
  return lastFailure(await store.listRuns(it.id))?.error_code ?? "unknown";
}

/**
 * The last failed run of an item held as `recurring_failure` (design 05-alarms), its code and detail through the
 * Withholder (run-outcome channel); null when it has none, and null with no read for any other item. `runs` are
 * the item's runs when the caller has read them.
 */
export async function heldFailureOf(c: NeedCtx, it: Pick<WorkItem, "id" | "blocked_reason">, runs?: readonly Run[]): Promise<HeldFailure | null> {
  if (it.blocked_reason !== RECURRING_FAILURE) return null;
  const outcome = lastFailure(runs ?? (await c.store.listRuns(it.id)));
  if (outcome === null) return null;
  return {
    outcome,
    code: await c.text(outcome.error_code, { channel: "run_outcome", max: 80 }),
    detail: outcome.detail ? await c.text(outcome.detail, { channel: "run_outcome", max: 200 }) : "",
  };
}

/** The latest run's ask (needs_human) of an item blocked on `agent_needs_human`, else null. */
async function latestAsk(store: NeedCtx["store"], it: WorkItem): Promise<{ question: string } | null> {
  for (const r of (await store.listRuns(it.id)).reverse()) {
    if (r.outcome?.status !== "succeeded") continue;
    const ask = parseNeedsHuman(r.outcome.data.needs_human);
    if (ask.ok && ask.value) return ask.value;
  }
  return null;
}
