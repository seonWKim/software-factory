// Delivery targets (RFC 0015 §7 Outbound handlers): each writes one kind of intent to one kind of destination,
// through the source adapter or the forge that holds its credentials (G2). Outbound is the only caller of their
// write calls (tests/architecture/forge-writes.test.ts).

import type { SourceRef } from "../../core/types.js";
import type { Forge, PrMergeResult } from "../../interfaces/forge.js";
import type { SourceAdapter, SourceNotice } from "../../interfaces/source-adapter.js";
import type { ActionRow } from "../intents.js";
import type { LocalGit } from "./local-git.js";

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
  /**
   * Writes several `notify` actions of one batch in one call (one message, design 12-notification-channels); throws
   * on a failure. Present only on a target that takes them: outbound calls it instead of `deliver` for those.
   */
  deliverBatch?(rows: readonly ActionRow[]): Promise<void>;
}

/** What the targets write through: the configured sources by type, the forge, and the factory repo it pushes from. */
export interface TargetDeps {
  readonly byType: ReadonlyMap<string, SourceAdapter>;
  readonly forge: Forge | null;
  /** The factory repo's path: where a run's last step wrote its commit (RFC 0015 M7). */
  readonly repo: string;
  /** The factory repo's merge and base push (RFC 0015 M8, the `local` target); null when this process has none. */
  readonly git?: LocalGit | null;
  /** The owner's tacit ledger (issue #570, a TacitLedger); absent or not enabled: no capture is delivered here. */
  readonly tacit?: TacitCapture | null;
}

/** What the tacit target needs of the owner's ledger: whether there is one, and its capture. */
export interface TacitCapture {
  readonly enabled: boolean;
  capture(p: { session: string; proposal: string; pushback: string }): Promise<void>;
}

/**
 * An action on `adapter`: the status label, the 👀, the close, a post with no thread entry, or a split's phase filed
 * under its parent (the adapter finds one already filed by its marker first, so a retry after a lost response
 * files no second one; the filed item's source id is the delivery's `ref`).
 */
export async function act(adapter: SourceAdapter, row: ActionRow): Promise<{ url: string | null; ref?: string }> {
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
    case "file_sub_issue": {
      if (!adapter.fileSubIssue) throw new Error(`the ${adapter.type} source cannot file sub-issues`);
      const ref = await adapter.fileSubIssue({ parent: row.target, title: String(a.title), body: String(a.body), marker: String(a.marker) });
      return { url: ref.link, ref: ref.id };
    }
    case "close_pr":
    case "merge_pr":
    case "push":
    case "pr":
      throw new Error(`a ${row.action} goes through the forge (github-change, github-push)`);
    case "merge":
    case "push_base":
      throw new Error(`a ${row.action} goes through the local target`);
    case "tacit_capture":
      throw new Error("a tacit_capture goes through the tacit target");
    case "notify":
      throw new Error("a notify goes through the notify target");
  }
}

/**
 * A `notify` action as `adapter` renders it: the unit's args, with the item's thread only when the item came from
 * this adapter's own source (a GitHub issue is no Slack thread).
 */
export function sourceNotice(adapter: Pick<SourceAdapter, "type">, row: ActionRow): SourceNotice {
  const a = row.args;
  const text = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
  return {
    kind: a.kind === "finished" || a.kind === "summary" ? a.kind : "needs_you",
    work_item_id: text(a.work_item_id),
    title: String(a.title ?? ""),
    reason: String(a.reason ?? ""),
    close_reason: text(a.close_reason),
    thread_url: a.source_type === adapter.type ? text(a.thread_url) : null,
    count: Number(a.count ?? 1),
  };
}

/** A delivered `merge_pr` action's result: the PR merged (its merge sha) or the forge's refusal. Null: not delivered. */
export function prMergeOutcome(row: ActionRow): PrMergeResult | null {
  return row.delivered_ref === null ? null : (JSON.parse(row.delivered_ref) as PrMergeResult);
}
