// The egress scan of a plain message and of the model's answer to it (design 04-gate-commands): the commands unit's
// plain replies and the intake unit's top-level chat messages both read a message through `readMessage`.

import type { Ctx } from "../context.js";

/**
 * Whether every text of a plain message's `what` (the message, or the model's answer: proposed arguments, chat text)
 * passes the egress scan. A finding is logged with its rules and `where` (the item or the source), never its text.
 */
export async function scanClean(c: Ctx, where: Record<string, string>, what: "message" | "answer", texts: readonly string[]): Promise<boolean> {
  for (const t of texts) {
    const scan = await c.k.d.scanner.scan("comment", t);
    if (scan.clean) continue;
    const rules = scan.findings.map((f) => f.rule).join(",");
    c.k.d.log.warn(`plain message ${what} blocked by the egress scan`, { ...where, rules });
    return false;
  }
  return true;
}
