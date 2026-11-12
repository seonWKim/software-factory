import type { Timestamp, Verdict } from "../../../core/types.js";
import type { RecordVerdictInput } from "../../../interfaces/factory-store.js";
import type { SqlExecutor } from "../../../state/index.js";

// One-tap verdicts (design 04-gate-commands): recordVerdict with `replace` updates the comment's one row in place.

/** Whether `input` is a duplicate of `existing`, stored under its comment id: always, unless `replace` changes it. */
export function isDuplicate(existing: Verdict, input: RecordVerdictInput): boolean {
  if (!input.replace || existing.work_item_id !== input.id) return true;
  return existing.verdict === input.verdict && existing.severity === input.severity && existing.reason === input.reason;
}

/** Updates `existing` in place with `input`'s kind, severity and reason, linked to the new state change; returns it. */
export async function replaceVerdict(
  tx: SqlExecutor, existing: Verdict, input: RecordVerdictInput, state_change_id: Verdict["state_change_id"], at: Timestamp,
): Promise<Verdict> {
  const v: Verdict = { ...existing, state_change_id, verdict: input.verdict, severity: input.severity, reason: input.reason, at };
  await tx.run("UPDATE controller_verdicts SET state_change_id = ?, verdict = ?, severity = ?, reason = ?, at = ? WHERE id = ?", [
    v.state_change_id, v.verdict, v.severity, v.reason, v.at, v.id,
  ]);
  return v;
}
