// What the permission gate on the commands unit's agent writes reads and writes (design 08-permissions, phase 2 of
// local-task-tk_cad55672): a sibling of the commands unit, as proposals.ts is. It hands `authorizeWrite`
// (src/core/authorize.ts) the store, for the mode read at each write and the held-write rows (controller_held_writes),
// since the kernel has no held-write write yet, and the egress scanner, one of the guards.

import type { Ctx } from "../context.js";

/** The gate's store and egress scanner, from the kernel's dependencies. */
export function writeGateDeps(c: Ctx) {
  return { store: c.k.d.store, scanner: c.k.d.scanner };
}
