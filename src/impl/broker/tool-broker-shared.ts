import type { FactoryStore } from "../../interfaces/factory-store.js";
import type { ToolCallContext, ToolDescriptor, ToolResult } from "../../interfaces/tool-broker.js";
import { holdsLease } from "./trusted-git.js";

/** A broker's `listTools`: the tools of its table that the grants name, in table order. */
export function grantedTools(tools: readonly ToolDescriptor[], grants: readonly string[]): ToolDescriptor[] {
  return tools.filter((t) => grants.includes(t.name));
}

/** The lease check at the start of every broker `call`: the `lease_lost` result when it fails, nothing when it holds. */
export async function leaseLost(store: Pick<FactoryStore, "getRun">, ctx: ToolCallContext): Promise<ToolResult | undefined> {
  if (await holdsLease(store, ctx)) return undefined;
  return { ok: false, error_code: "lease_lost", message: "run no longer holds its lease" };
}
