// The permission gate on the controller's agent writes (design 08-permissions, phase 2 of local-task-tk_cad55672): a
// sibling of the commands unit, as proposals.ts is. `authorizeWrite` (src/core/authorize.ts) runs the guards, reads
// the mode from the store at this write and holds the write once per key in controller_held_writes.

import { type WriteDecision, type WriteRequest, authorizeWrite } from "../../../core/authorize.js";
import type { Ctx } from "../context.js";

/** One agent write through the guards and the gate; a held or refused write is logged with the mode or reason. */
export async function gateAgentWrite(c: Ctx, w: Omit<WriteRequest, "origin">): Promise<WriteDecision> {
  const d = await authorizeWrite({ store: c.k.d.store, scanner: c.k.d.scanner }, { ...w, origin: "agent" });
  if (d.outcome === "held") c.k.d.log.info("agent write held", { command: w.command.name, held_write: d.id, mode: d.mode });
  if (d.outcome === "refused") c.k.d.log.warn("agent write refused", { command: w.command.name, reason: d.reason });
  return d;
}
