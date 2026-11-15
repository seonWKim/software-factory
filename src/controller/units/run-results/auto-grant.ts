// An implement run's needs_human ask for test paths only (design 05-restarts, decided 2026-11-15): the owner's
// `/retry +paths` applied by the controller, once per item. Kept out of run-results.unit.ts, which may not grow (file
// budget); the path check (src/core/auto-grant.ts) is reached through the live settings, so no new legacy import.

import type { Ctx } from "../context.js";
import { type Decision, SYSTEM, footerAfter, retry } from "../support.js";
import type { RunResultsUnit } from "./run-results.unit.js";

type Stop = Parameters<RunResultsUnit["needsHuman"]>;
type Change = Awaited<ReturnType<Ctx["k"]["reader"]["listStateChanges"]>>[number];

/** The state change detail key that marks a `/retry +paths` the controller applied itself. */
export const AUTO_GRANT = "auto_grant";
/** At most this many automatic grants per item; a later ask waits on the owner. */
export const MAX_AUTO_GRANTS = 1;

/** The automatic grants among an item's stored state changes, oldest first. */
export function autoGrants<C extends Pick<Change, "reason" | "detail">>(changes: readonly C[]): C[] {
  return changes.filter((c) => c.reason === "retry_requested" && c.detail?.[AUTO_GRANT] === true);
}

/**
 * The grant for `stopped` (the item as the needs-human block would leave it) when every asked path is a test file
 * off the gate list and the switch is on: `retry` with the system actor, the paths widened as `/retry +paths` widens
 * them, in the transition that acknowledges the run. Counted from the stored state changes, so a restart or another
 * worker sees it. undefined: ask the owner as before. null: this run's grant is stored already (another worker
 * applied it, and the paths are allowed now), so nothing changes and no owner comment is posted.
 */
export async function autoGrant(c: Ctx, stopped: Stop[0], run: Stop[1], asked: readonly string[], reply: string | null, tokens: number): Promise<Decision | undefined> {
  const grants = autoGrants(await c.k.reader.listStateChanges(stopped.id));
  if (grants.some((g) => g.detail?.run_id === run.id)) return null;
  if (!reply || grants.length >= MAX_AUTO_GRANTS || !c.k.live.autoGrantable(stopped.project, asked)) return undefined;
  const note = `${asked.join(", ")} granted automatically because the ask named test paths only (auto_grant_test_paths)`;
  const d = retry(stopped, SYSTEM, "implement", note, c.unit("commands").widen(stopped, asked));
  if (!d || "refuse" in d) return undefined;
  const body = [
    "## Factory: test paths granted automatically",
    "",
    "The implement run stopped and asked for paths outside the allowed paths. Every path it named is a test file and none is on the gate list, so the factory applied this itself:",
    "",
    "```", reply, "```",
    "",
    `Granted automatically because the ask named test paths only (\`auto_grant_test_paths\`): ${asked.map((p) => `\`${p}\``).join(", ")}. The implementer runs again; the review checks that the test edits only follow the change. This happens once per item: a later ask waits for you.`,
    "",
    footerAfter(stopped, d.patch),
  ].join("\n");
  if (!(await c.k.d.scanner.scan("comment", body)).clean) return undefined;
  await c.unit("outbox").comment(stopped, `auto-grant:${run.id}`, body);
  c.k.d.log.info("test paths granted automatically because the ask named test paths only", { work_item_id: stopped.id, run_id: run.id, paths: asked.join(" ") });
  return { ...d, patch: { ...d.patch, token_cost: tokens }, detail: { ...d.detail, run_id: run.id, [AUTO_GRANT]: true }, ack_run: run.id };
}
