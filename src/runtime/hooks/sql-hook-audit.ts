// The hook audit on the state store: one runtime_hook_decisions row per hook decision (RFC 0015 §8, "audited").

import type { SqlExecutor } from "../../state/index.js";
import type { HookAudit, HookDecision } from "./run-hooks.js";

export class SqlHookAudit implements HookAudit {
  constructor(private readonly db: SqlExecutor) {}

  async record(decisions: readonly HookDecision[]): Promise<void> {
    for (const d of decisions) {
      await this.db.run(
        "INSERT INTO runtime_hook_decisions (hook, point, subject, project_id, passport_id, outcome, text, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [d.hook, d.point, d.subject, d.project_id, d.passport_id, d.outcome, d.text, d.at],
      );
    }
  }

  /** The newest decisions about `subject`, newest first. */
  async forSubject(subject: string, limit = 50): Promise<HookDecision[]> {
    const rows = await this.db.all(
      "SELECT hook, point, subject, project_id, passport_id, outcome, text, at FROM runtime_hook_decisions WHERE subject = ? ORDER BY seq DESC LIMIT ?",
      [subject, limit],
    );
    return rows.map((r) => ({
      hook: String(r.hook),
      point: String(r.point) as HookDecision["point"],
      subject: String(r.subject),
      project_id: String(r.project_id),
      passport_id: r.passport_id === null ? null : String(r.passport_id),
      outcome: String(r.outcome) as HookDecision["outcome"],
      text: r.text === null ? null : String(r.text),
      at: String(r.at),
    }));
  }
}
