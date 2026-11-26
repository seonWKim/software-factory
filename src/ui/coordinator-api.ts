// The Coordinator read (design 09-dashboard-system, over 05-coordinator): GET /api/v1/coordinator, declared once as the
// `coordinator.status` capability (src/api/capabilities/coordinator.ts) and called by the Work page's Coordinator card
// through the generated client. The coordinator setting (the switch), the due time of its next cycle and its recent
// action records, newest first, each with the storage key of its transcript. Reads only.

import type { UiDeps } from "./deps.js";

/** The store's SQL reads (src/state SqlExecutor.all); a test gives a fake. */
type Reads = { all(sql: string, params?: readonly (string | number | null)[]): Promise<Record<string, unknown>[]> };

/** Recent actions the card shows. */
export const RECENT_ACTIONS = 10;

/** The stored transcript reference (`storage:<key>`, src/coordinator/agent.ts) as its storage key; null for none or another form. */
export function transcriptKey(ref: string | null): string | null {
  return ref !== null && ref.startsWith("storage:") && ref.length > "storage:".length ? ref.slice("storage:".length) : null;
}

/** GET /api/v1/coordinator. `db` is the store's SQL database; a test gives a fake. */
export async function readCoordinator(d: Pick<UiDeps, "store" | "clock" | "settings">, db?: Reads) {
  // Loaded inside the read, like the capability loads this file: a top-level import would add layering edges to the ratchet.
  const sql = db ?? (await import("../impl/store/sql/store-sql.js")).storeSql(d.store);
  const { CoordinatorStore } = await import("../coordinator/store.js");
  const { effectiveGlobal } = await import("./settings-api.js");
  const rows = await sql.all("SELECT * FROM controller_coordinator_actions ORDER BY recorded_at DESC, seq DESC LIMIT ?", [RECENT_ACTIONS]);
  return {
    as_of: d.clock.now().toISOString(),
    on: (await effectiveGlobal(d as UiDeps, "coordinator")).value,
    next_check_at: await new CoordinatorStore(sql as ConstructorParameters<typeof CoordinatorStore>[0]).dueAt(),
    actions: rows.map((r) => ({
      cycle_id: String(r.cycle_id), seq: Number(r.seq), command: String(r.command), work_item_id: r.work_item_id === null ? null : String(r.work_item_id),
      outcome: String(r.outcome), reason: String(r.reason), at: String(r.recorded_at),
      transcript: transcriptKey(r.transcript_link === null ? null : String(r.transcript_link)),
    })),
  };
}
