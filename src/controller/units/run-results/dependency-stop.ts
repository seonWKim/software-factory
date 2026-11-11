// An implement run's needs_human stop on an unmerged dependency (design §5 Restarts, decided 2026-11-12): the agent
// waits on another item, not on a person. Kept out of run-results.unit.ts, which may not grow (file budget), and
// reads the edges through the coordination unit, which owns them, so the run-results unit reaches no new store.

import type { Ctx } from "../context.js";
import { type Decision, SYSTEM } from "../support.js";
import type { RunResultsUnit } from "./run-results.unit.js";

type Stop = Parameters<RunResultsUnit["needsHuman"]>;

/**
 * The dependency hold for an implement run's needs_human whose reason names one of the item's stored open
 * dependency edges as a whole reference (`#9` does not match `#92`), on an item without a PR (coordination changes
 * only those): `blocked_on: dependency`, `waiting for #N to merge`, and one implement run queued under a key that
 * names the stopped run. The store keeps it queued while the edge is open; coordination's release lets it start
 * once the edge merges. One comment says what it waits for, with no retry footer. Null for any other stop.
 */
export async function dependencyStop(c: Ctx, it: Stop[0], run: Stop[1], ask: Stop[2], tokens: number): Promise<Decision> {
  if (run.kind !== "implement" || it.change_ref !== null) return null;
  const v = await c.unit("coordination").readDependencies(it, "stored");
  const open = v.kind === "wait" ? v.open.filter((d) => namesRef(ask.reason, shortRef(d, it.source.id))) : [];
  if (open.length === 0) return null;
  const reason = `waiting for ${list(open.map((d) => shortRef(d, it.source.id)))} to merge`;
  await c.unit("outbox").comment(it, `needs-human:${run.id}`, [
    "## Factory: the implement run waits for a dependency",
    "",
    `The implement run stopped: ${reason}. Nothing was pushed. It starts again on its own once ${open.length === 1 ? "it merges" : "they merge"}.`,
  ].join("\n"));
  return {
    patch: { blocked_on: "dependency", blocked_reason: reason, token_cost: tokens },
    actor: SYSTEM,
    reason: "dependency_hold",
    detail: { run_id: run.id, run_kind: run.kind, depends_on: open.join(",") },
    ack_run: run.id,
    enqueue: { kind: "implement", idempotency_key: `${it.id}:implement:after-dependency:${run.id}` },
  };
}

/** True when `text` names `ref` (`#9`, `owner/name#9`) as a whole: not inside `#92` or `other/repo#9`. */
function namesRef(text: string, ref: string): boolean {
  const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w./#-])${escaped}(?!\\d)`).test(text);
}

// The next two copy core/coordination.ts `shortRef` and `dependencyReason`'s list, so the reason reads exactly as
// coordination's own hold: a controller unit may not import core/ anew (tests/architecture dependency-direction).

/** "#92" for an item of the same repository as `self` ("owner/repo#N" source ids), else the whole id. */
function shortRef(id: string, self: string): string {
  const [repo, n] = id.split("#");
  return repo === self.split("#")[0] && n ? `#${n}` : id;
}

/** "#1", "#1 and #2", "#1, #2 and #3". */
function list(parts: readonly string[]): string {
  return parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}
