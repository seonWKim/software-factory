// The coordinator's two tables (design 05-coordinator), over the store's SQL database: the due time of the next cycle
// (`controller_coordinator_due`, one row named `coordinator`) and the action records (`controller_coordinator_actions`).
// Every write is conditional or keyed, so a second replica or a rerun changes nothing the first did.

import type { WorkItemId } from "../core/types.js";
import type { SqlExecutor } from "../state/index.js";

/** The due row's name: one coordinator per store. */
const NAME = "coordinator";

/** What came of one action: requested through a command, refused by the cycle's checks, skipped, or failed. */
export type ActionOutcome = "requested" | "refused" | "skipped" | "failed";

/** One action record, as a cycle writes it. */
export interface CoordinatorAction {
  cycle_id: string;
  /** The action's place in its cycle, from 1. */
  seq: number;
  work_item_id: WorkItemId | null;
  command: string;
  outcome: ActionOutcome;
  reason: string;
  /** Where the cycle's transcript is stored (`storage:<key>`); null when it was withheld or not stored. */
  transcript_link: string | null;
}

export type StoredAction = CoordinatorAction & { recorded_at: string };

export class CoordinatorStore {
  constructor(private readonly db: SqlExecutor) {}

  /** When the next cycle is due; null before the first cycle. */
  async dueAt(): Promise<string | null> {
    const [row] = await this.db.all("SELECT due_at FROM controller_coordinator_due WHERE name = ?", [NAME]);
    return row ? String(row.due_at) : null;
  }

  /**
   * Moves the due time from `seen` (null: no row yet) to `next` for cycle `cycle_id`, at `now`. Conditional: only
   * the replica whose update finds `seen` still stored claims the cycle; every other one gets false.
   */
  async claim(seen: string | null, next: string, cycle_id: string, now: string): Promise<boolean> {
    const n = seen === null
      ? await this.db.run("INSERT INTO controller_coordinator_due (name, due_at, cycle_id, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (name) DO NOTHING", [NAME, next, cycle_id, now])
      : await this.db.run("UPDATE controller_coordinator_due SET due_at = ?, cycle_id = ?, updated_at = ? WHERE name = ? AND due_at = ?", [next, cycle_id, now, NAME, seen]);
    return n === 1;
  }

  /** Stores one action record; a record already stored for its cycle and place is kept as it is. */
  async record(a: CoordinatorAction, now: string): Promise<void> {
    await this.db.run(
      `INSERT INTO controller_coordinator_actions (cycle_id, seq, work_item_id, command, outcome, reason, transcript_link, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (cycle_id, seq) DO NOTHING`,
      [a.cycle_id, a.seq, a.work_item_id, a.command, a.outcome, a.reason, a.transcript_link, now],
    );
  }

  /** The records of cycle `cycle_id`, in order. */
  async actions(cycle_id: string): Promise<StoredAction[]> {
    const rows = await this.db.all("SELECT * FROM controller_coordinator_actions WHERE cycle_id = ? ORDER BY seq", [cycle_id]);
    return rows.map((r) => ({
      cycle_id: String(r.cycle_id), seq: Number(r.seq), work_item_id: r.work_item_id === null ? null : (String(r.work_item_id) as WorkItemId),
      command: String(r.command), outcome: String(r.outcome) as ActionOutcome, reason: String(r.reason),
      transcript_link: r.transcript_link === null ? null : String(r.transcript_link), recorded_at: String(r.recorded_at),
    }));
  }
}
