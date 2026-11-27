// What the permission gate on the commands unit's writes reads and writes (design 08-permissions, local-task-tk_cad55672):
// a sibling of the commands unit, as proposals.ts is. It hands `authorizeWrite` (src/core/authorize.ts) the store,
// for the mode read at each write, the held-write rows (controller_held_writes) and the run agent writes' command
// rows, since the kernel has no such write yet, and the egress scanner, one of the guards.

import type { Ctx } from "../context.js";
import type { CommandsUnit } from "./commands.unit.js";

type InboxCommand = Parameters<CommandsUnit["handleInboxCommand"]>[0];
/** `authorizeWrite` on a typed command's name and `args`, as the commands unit calls it: refused with its reason, or not. */
type TypedGate = (args: string[]) => Promise<{ outcome: string; reason?: string }>;

/** The gate's store and egress scanner, from the kernel's dependencies. */
export function writeGateDeps(c: Ctx) {
  return { store: c.k.d.store, scanner: c.k.d.scanner };
}

/**
 * Whether the inbox applies command row `cmd`: an agent's row is a write the gate already ran (never applied again);
 * a typed command (`human_command`) first passes `gate`, the guards an agent write passes, in every mode (a secret
 * read, the egress scan of its name and arguments), else its row is stored handled with the refusal, which is logged.
 * Any other row (an app request, a row from before write origins) applies as before. Safe to run twice: the scan is
 * the same, and a row refused already stays as it is.
 */
export async function inboxApplies(c: Ctx, cmd: InboxCommand, gate: TypedGate): Promise<boolean> {
  if (cmd.write_origin === "agent") return false;
  if (cmd.write_origin !== "human_command") return true;
  const d = await gate(Object.values(cmd.args).map((v) => (typeof v === "string" ? v : JSON.stringify(v))));
  if (d.outcome !== "refused") return true;
  await c.k.d.store.refuseCommand(cmd.id, d.reason ?? d.outcome);
  c.k.d.log.warn("typed command refused", { command_key: cmd.key, command: cmd.command, reason: d.reason });
  return false;
}
