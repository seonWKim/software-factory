// Interactive sessions (design §5, 2026-11-01): a session's updates (notes, last finish, tokens), kept out of
// sql-factory-store.ts so that file stays within its line budget. Fenced by the run's lease token like a heartbeat.
// The session start is a claim, so it stays in the class with claimRun.

import type { RunId, SessionRecord } from "../../../core/types.js";
import type { LeaseResult, SessionUpdate } from "../../../interfaces/factory-store.js";
import type { SqlDriver } from "../../../state/index.js";
import type { StoreSteps, StoreTime } from "./store-steps.js";

export async function updateSession(db: SqlDriver, time: StoreTime, store: StoreSteps, runId: RunId, token: number, update: SessionUpdate): Promise<LeaseResult> {
  return db.transaction(async (tx): Promise<LeaseResult> => {
    const run = await store.selectRun(tx, runId);
    const s = run?.input?.session;
    if (!run || !s || run.status !== "running" || run.lease?.token !== token) return { ok: false, reason: "lease_lost" };
    const now = time.now();
    const next: SessionRecord = {
      ...s,
      ...(update.note !== undefined ? { notes: [...s.notes, { at: now, text: update.note }].slice(-MAX_SESSION_NOTES) } : {}),
      ...(update.last_finish !== undefined ? { last_finish: { ...update.last_finish, at: now } } : {}),
    };
    await tx.run("UPDATE worker_runs SET input = ?, session_tokens = ?, transcript_url = ?, updated_at = ? WHERE id = ?", [
      JSON.stringify({ ...run.input, session: next }), update.tokens ?? run.session_tokens, update.transcript_url ?? run.transcript_url, now, runId,
    ]);
    return { ok: true, run: (await store.selectRun(tx, runId))! };
  });
}

/** Notes kept per session: the newest ones. */
const MAX_SESSION_NOTES = 200;
