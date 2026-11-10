// The signal ledger writer (design 11-signal-ledger, issue #491). A pure step: `load` asks each discovered signal
// source (`*.signal.ts`) for its records since the newest stored signal of that source, less a 10-minute overlap, and
// reads the standing rule that approved each record's item; `decide` turns the records into ledger rows the router
// commits, each an insert that skips a stored (source, source_ref). It names no source, holds nothing in memory, and
// writes nothing else: no state change, verdict, run, intent or item field.

import { ROLES, STANDING_APPROVED, type SignalDescriptor, type SignalRecord, type SignalTime } from "../../signals/signal.js";
import type { ControllerReader } from "../kernel.js";
import type { ControllerDecision } from "../context.js";
import { controllerUnit } from "../context.js";

/** How far before the newest stored signal of a source its next read starts: a record stored late is still read. */
export const OVERLAP_MS = 10 * 60_000;

/** One source's records as loaded. */
interface Batch {
  readonly source: Pick<SignalDescriptor, "name" | "kinds">;
  readonly records: readonly SignalRecord[];
}

interface Loaded {
  readonly batches: readonly Batch[];
  /** The standing rule ID that approved each item, by item ID; an item no rule approved is absent. */
  readonly rules: ReadonlyMap<string, string>;
}

/** Where a source's read starts: its newest stored signal less the overlap; null (every record) when it has none. */
export function readFrom(latest: SignalTime | null): SignalTime | null {
  return latest === null ? null : (new Date(Date.parse(latest) - OVERLAP_MS).toISOString() as SignalTime);
}

/** Writes the signal ledger. */
export class SignalsUnit {
  async load(r: ControllerReader): Promise<Loaded> {
    const batches: Batch[] = [];
    for (const source of await r.signals()) {
      // The first read of a source (no stored signal) is the backfill: every record it has.
      const since = readFrom(await r.latestSignalAt(source.name));
      batches.push({ source, records: await source.read(r, since) });
    }
    const ids = [...new Set(batches.flatMap((b) => b.records.map((x) => x.work_item_id)))];
    const approvals = ids.length === 0 ? [] : await r.listStateChangesSince({ reasons: [STANDING_APPROVED], since: null, work_item_ids: ids });
    const rules = new Map<string, string>();
    for (const c of approvals) if (typeof c.detail?.standing_rule === "string") rules.set(c.work_item_id, c.detail.standing_rule);
    return { batches, rules };
  }

  /** One ledger row per record; a record of a kind or role its source does not list is left out, with a warning. */
  decide(l: Loaded): ControllerDecision {
    const writes: ControllerDecision["writes"][number][] = [];
    for (const { source, records } of l.batches) {
      let dropped = 0;
      for (const x of records) {
        if (!source.kinds.includes(x.kind) || (x.role !== null && !(ROLES as readonly string[]).includes(x.role))) {
          dropped++;
          continue;
        }
        writes.push({
          kind: "signal",
          signal: {
            source: source.name, source_ref: x.source_ref, kind: x.kind, work_item_id: x.work_item_id,
            role: x.role, rule: l.rules.get(x.work_item_id) ?? null, at: x.at,
          },
        });
      }
      if (dropped > 0) writes.push({ kind: "log", level: "warn", msg: "signal records of an unlisted kind or role were not written", fields: { source: source.name, dropped } });
    }
    return { writes };
  }
}

declare module "../../router/unit.js" {
  interface UnitOperations {
    "signals": SignalsUnit;
  }
}

export default controllerUnit({
  name: "signals",
  create: () => new SignalsUnit(),
  steps: [
    {
      name: "signal ledger", every: "poll", order: 75,
      load: (u, r) => u.load(r),
      decide: (u, loaded: Loaded) => u.decide(loaded),
    },
  ],
});
