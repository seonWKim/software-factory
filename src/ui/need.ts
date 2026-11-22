// What a waiting item's row says (design §9): the reason in plain words, where to act, and the command to type.
// For the items API (api.ts): one function, so every row gives the same reason for the same item. Store reads
// only, no forge call: the PR link is the item's stored change_url. A reason with nothing to add to the item's
// why (why.ts) is `from_why`: the app shows the why's en.ts text instead, so Tasks and Work say the same words.

import { LOCAL_SOURCE } from "../core/local-merge.js";
import { parseNeedsHuman } from "../core/outputs.js";
import { FAILED_PHASES, phaseOf } from "../core/phase.js";
import type { Run, WorkItem } from "../core/types.js";
import type { FactoryStore } from "../interfaces/factory-store.js";
import type { HeldFailure } from "./why.js";
import type { Withholder } from "./withhold.js";

/** What a waiting item's row says. `reason` is plain text (the caller escapes it for HTML). */
export interface Need {
  reason: string;
  /** True when the reason adds nothing to the item's why: the app shows the why's text (one en.ts text per reason code). */
  from_why: boolean;
  url: string;
  label: string;
  command: string | null;
}

/** What needOf reads: the store for a failed run's message, and the egress scan of free text. */
export interface NeedCtx {
  store: Pick<FactoryStore, "listRuns">;
  /** The value through the Withholder (cut to `max`), as plain text. */
  text(value: string, opts?: { channel?: "run_outcome"; max?: number }): Promise<string>;
}

/** needOf's context from the store and the page's Withholder. */
export function needCtx(store: NeedCtx["store"], w: Pick<Withholder, "plain">): NeedCtx {
  return { store, text: async (v, o) => (await w.plain(v, o)).text };
}

/** A failed item's reason when its latest failed run stored no message. */
const NO_MESSAGE = "The last run failed with no message.";

/** A ready-to-merge item's merge check: its state and how many files conflict. */
export interface MergeCheckNeed {
  state: "mergeable" | "checking" | "conflicts";
  conflicts: number;
}

/** The merge check in words: "mergeable", "checking", or the conflict count. */
function mergeText(m: MergeCheckNeed): string {
  if (m.state === "mergeable") return "mergeable";
  if (m.state === "checking") return "merge check running";
  return `${m.conflicts} conflicting ${m.conflicts === 1 ? "file" : "files"}`;
}

/** The item's need, by its phase (core/phase.ts). `check` is the merge check of a ready-to-merge item, when the caller has it. */
export async function needOf(c: NeedCtx, it: WorkItem, check: MergeCheckNeed | null = null): Promise<Need> {
  const issue = { url: it.source.link, label: "issue" };
  const reason = it.blocked_reason ?? "";
  const p = phaseOf(it);
  const stored = (url: string | null, label: string) => (url === null ? issue : { url, label });
  if (p === "spec_pending") {
    return { reason: "spec ready", from_why: false, ...stored(it.spec_comment_url, "spec comment"), command: "/approve or /reject <reason>" };
  }
  if (p === "merge_pending") {
    // The Merge button merges it (design §9); a local item also merges with `factory merge <id>`.
    const local = it.source.type === LOCAL_SOURCE;
    return {
      reason: check ? mergeText(check) : "ready to merge",
      from_why: false,
      ...(local ? issue : stored(it.change_url, `PR #${it.change_ref}`)),
      command: local ? `factory merge ${it.id}` : null,
    };
  }
  if (FAILED_PHASES.has(p)) {
    // The first line of the latest failed run's stored message: what went wrong, not its code.
    const line = lastFailure(await c.store.listRuns(it.id))?.detail?.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
    const said = line === "" ? NO_MESSAGE : await c.text(line, { channel: "run_outcome", max: 80 });
    return { reason: said, from_why: false, ...stored(it.failure_comment_url, "failure comment"), command: "/retry" };
  }
  if (p === "agent_needs_human") {
    const ask = await latestAsk(c.store, it);
    if (ask) return { reason: await c.text(ask.question, { max: 200 }), from_why: false, ...stored(it.failure_comment_url, "Answer"), command: null };
  }
  const command = p === "recurring_failure" ? "/retry" : null;
  // A null reason gets fixed words, never an empty or "no reason" text.
  if (reason === "") return { reason: "waiting for a person", from_why: true, ...issue, command };
  // Scan the stored reason itself: the reworded text could hide a secret from the scanner.
  const shown = await c.text(reason);
  return { reason: shown !== reason ? shown : reason.replace(/[_:]+/g, " "), from_why: true, ...issue, command };
}

/** The item's latest failed run's outcome, or null when it has none. */
function lastFailure(runs: readonly Run[]): HeldFailure["outcome"] | null {
  const failed = runs.filter((r) => r.outcome?.status === "failed");
  const last = failed.reduce<Run | null>((a, r) => (a === null || (r.finished_at ?? r.updated_at) >= (a.finished_at ?? a.updated_at) ? r : a), null);
  return last?.outcome?.status === "failed" ? last.outcome : null;
}

/**
 * The last failed run of an item held as `recurring_failure` (design 05-alarms), its code and detail through the
 * Withholder (run-outcome channel); null when it has none, and null with no read for any other item. `runs` are
 * the item's runs when the caller has read them.
 */
export async function heldFailureOf(c: NeedCtx, it: Pick<WorkItem, "id" | "stage" | "blocked_on" | "blocked_reason" | "close_reason">, runs?: readonly Run[]): Promise<HeldFailure | null> {
  if (phaseOf(it) !== "recurring_failure") return null;
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
