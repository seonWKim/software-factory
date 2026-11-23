// An implement run's needs_human ask the controller answers itself, once per item (design 05-restarts): test paths
// only (decided 2026-11-15) or a few ordinary files (2026-11-19, src/core/auto-grant.ts fewOrdinaryPaths), the owner's `/retry +paths` applied by the controller; or paths already allowed only
// (decided 2026-11-16: a ratchet list or a path under allowed_paths), a plain retry that says they are allowed.
// Kept out of run-results.unit.ts, which may not grow (file budget); the path check (src/core/auto-grant.ts) is
// reached through the live settings, so no new legacy import.

import type { Ctx } from "../context.js";
import { type Decision, SYSTEM, footerAfter, retry } from "../support.js";
import type { needsHuman } from "./notices.js";

type Stop = Parameters<typeof needsHuman>;
type Change = Awaited<ReturnType<Ctx["k"]["reader"]["listStateChanges"]>>[number];
/** An ask's paths: every one it named (`named`), those no allowed path covers (`asked`), and the owner's reply for them. */
export type Ask = { named: readonly string[]; asked: readonly string[]; reply: string | null };

/** The state change detail key that marks a retry the controller applied itself. */
export const AUTO_GRANT = "auto_grant";
/** At most this many automatic grants per item, of either kind; a later ask waits on the owner. */
export const MAX_AUTO_GRANTS = 1;

/** The automatic grants among an item's stored state changes, oldest first. */
export function autoGrants<C extends Pick<Change, "reason" | "detail">>(changes: readonly C[]): C[] {
  return changes.filter((c) => c.reason === "retry_requested" && c.detail?.[AUTO_GRANT] === true);
}

/** `auto_grant_test_paths` for `project`: its own value where it has one, else the global one. */
function switchedOn(c: Ctx, project: string): boolean {
  const r = c.k.live.resolved();
  return (r.projects[project]?.auto_grant_test_paths ?? r.global.auto_grant_test_paths).value === true;
}

/**
 * The grant for `stopped` (the item as the needs-human block would leave it), with the system actor, in the
 * transition that acknowledges the run, when the switch is on and the item had none yet: an ask whose every path is
 * a test file off the gate list gets them widened as `/retry +paths` widens them; an ask whose every path is covered
 * already is retried with no widening and a note naming them as allowed. Counted from the stored state changes, so a
 * restart or another worker sees it. undefined: ask the owner as before. null: this run's grant is stored already
 * (another worker applied it), so nothing changes and no owner comment is posted.
 */
export async function autoGrant(c: Ctx, stopped: Stop[1], run: Stop[2], ask: Ask, tokens: number): Promise<Decision | undefined> {
  const grants = autoGrants(await c.k.reader.listStateChanges(stopped.id));
  if (grants.some((g) => g.detail?.run_id === run.id)) return null;
  if (grants.length >= MAX_AUTO_GRANTS) return undefined;
  const covered = ask.named.length > 0 && ask.asked.length === 0;
  if (covered ? !switchedOn(c, stopped.project) : !ask.reply || !c.k.live.autoGrantable(stopped.project, ask.asked)) return undefined;
  const t = covered ? coveredTexts(ask.named) : testTexts(ask.asked, ask.reply!, c.k.live.testPathsOnly(ask.asked));
  const d = retry(stopped, SYSTEM, "implement", t.note, covered ? null : c.unit("commands").widen(stopped, ask.asked));
  if (!d || "refuse" in d) return undefined;
  const body = [...t.body, "", footerAfter(stopped, d.patch)].join("\n");
  if (!(await c.k.d.scanner.scan("comment", body)).clean) return undefined;
  await c.unit("outbox").comment(stopped, `auto-grant:${run.id}`, body);
  c.k.d.log.info(t.log, { work_item_id: stopped.id, run_id: run.id, paths: (covered ? ask.named : ask.asked).join(" ") });
  return { ...d, patch: { ...d.patch, token_cost: tokens }, detail: { ...d.detail, run_id: run.id, [AUTO_GRANT]: true }, ack_run: run.id };
}

const ONCE = "This happens once per item: a later ask waits for you.";

/**
 * The retry note, the comment lines and the log line of a grant: test paths only (`tests`), or a few ordinary files
 * (fewOrdinaryPaths, since 2026-11-19), which saves a trip back to triage for a plan that missed a file.
 */
function testTexts(asked: readonly string[], reply: string, tests: boolean) {
  const why = tests ? "the ask named test paths only" : "the ask named a few ordinary files";
  return {
    note: `${asked.join(", ")} granted automatically because ${why} (auto_grant_test_paths)`,
    log: `${tests ? "test paths" : "files"} granted automatically because ${why}`,
    body: [
      `## Factory: ${tests ? "test paths" : "files"} granted automatically`,
      "",
      `The implement run stopped and asked for paths outside the allowed paths. ${tests ? "Every path it named is a test file" : "It named a few files"} and none is on the gate list, so the factory applied this itself:`,
      "",
      "```", reply, "```",
      "",
      `Granted automatically because ${why} (\`auto_grant_test_paths\`): ${asked.map((p) => `\`${p}\``).join(", ")}. The implementer runs again; the review checks that the edits there only follow the change. ${ONCE}`,
    ],
  };
}

/** The retry note, the comment lines and the log line of an ask whose every path was allowed already. */
function coveredTexts(named: readonly string[]) {
  const allowed = `already allowed: ${named.join(", ")}`;
  return {
    note: `${allowed}. Each is under the allowed paths or is a ratchet list: known-violations lists are always editable to shrink (never to grow). Edit them and go on without asking.`,
    log: "needs-human ask requeued because every path it named is already allowed",
    body: [
      "## Factory: the asked paths are already allowed",
      "",
      `The implement run stopped and asked for paths the factory already allows, so it runs again with a note saying so; the allowed paths are unchanged. ${ONCE}`,
      "",
      allowed,
    ],
  };
}
