// Delivery targets (RFC 0015 §7 Outbound handlers): each writes one kind of intent to one kind of destination,
// through the source adapter or the forge that holds its credentials (G2). Outbound is the only caller of their
// write calls (tests/architecture/forge-writes.test.ts).

import type { SourceRef } from "../../core/types.js";
import type { Forge } from "../../interfaces/forge.js";
import type { SourceAdapter } from "../../interfaces/source-adapter.js";
import type { ActionRow } from "../intents.js";

/** One intent as a target delivers it: a thread entry's comment, or an action. */
export type Delivery =
  | { readonly kind: "comment"; readonly source_type: string; readonly target: SourceRef; readonly body: string; readonly marker: string }
  | { readonly kind: "action"; readonly row: ActionRow };

export interface DeliveryTarget {
  /** The RFC's handler name: `github-change`, `github-comment`, `github-labels`, `slack-thread`, `local`, `source`. */
  readonly name: string;
  accepts(d: Delivery): boolean;
  /** Writes it; throws on a failure. A comment returns its URL; a PR its number (`ref`) and link. */
  deliver(d: Delivery): Promise<{ url: string | null; ref?: string }>;
}

/** What the targets write through: the configured sources by type, the forge, and the factory repo it pushes from. */
export interface TargetDeps {
  readonly byType: ReadonlyMap<string, SourceAdapter>;
  readonly forge: Forge | null;
  /** The factory repo's path: where a run's last step wrote its commit (RFC 0015 M7). */
  readonly repo: string;
}

/** An action on `adapter`: the status label, the 👀, the close, or a post with no thread entry. */
export async function act(adapter: SourceAdapter, row: ActionRow): Promise<{ url: string | null }> {
  const a = row.args;
  switch (row.action) {
    case "status":
      await adapter.setStatus(row.target, a.status as Parameters<SourceAdapter["setStatus"]>[1], (a.change_ref as string | null) ?? null);
      return { url: null };
    case "seen":
      await adapter.markSeen(row.target, (a.comment_id as string | null) ?? null);
      return { url: null };
    case "close":
      await adapter.closeIssue(row.target, (a.reason as Parameters<SourceAdapter["closeIssue"]>[1]) ?? undefined);
      return { url: null };
    case "post":
      return adapter.postComment(row.target, String(a.body), String(a.marker));
    case "close_pr":
    case "push":
    case "pr":
      throw new Error(`a ${row.action} goes through the forge (github-change, github-push)`);
  }
}
