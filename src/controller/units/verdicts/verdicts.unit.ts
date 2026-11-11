// Verdicts: a person's verdict, implicit verdicts (merges, pushes, reverts) and fix-forward links.
// Moved out of the legacy controller (RFC 0015 M5); its I/O is still inline (unit-purity ratchet).

import { prNumber } from "../../../core/change-ref.js";
import { LOCAL_SOURCE } from "../../../core/local-merge.js";
import { workItemIdFromBranch } from "../../../core/policy.js";
import { type Actor, type StateChangeDetail, type VerdictKind, type VerdictSeverity, type VerdictTarget, type WorkItem, type WorkItemId } from "../../../core/types.js";
import { type ParsedVerdict, parseVerdict, verdictRefusal } from "../../../core/verdict.js";
import type { Principal } from "../../../interfaces/auth-provider.js";
import type { Forge } from "../../../interfaces/forge.js";
import type { SourceEvent } from "../../../interfaces/source-adapter.js";
import { MAX_CONFLICT_RETRIES } from "../support.js";
import type { Ctx } from "../context.js";
import { controllerUnit } from "../context.js";
import { LocalForge } from "../../../impl/forge/local-forge.js";

type BaseCommitEvent = Extract<SourceEvent, { kind: "base_commit" }>;
type VerdictEvent = Extract<SourceEvent, { kind: "verdict_submitted" }>;
/** Records reverts and fix-forwards (design §6). */
const LINKS: Actor = { kind: "system", id: "system:links" };
/** What an implicit verdict says (design §4): its kind and severity, its reason and its event key. */
interface ImplicitVerdict {
  verdict: VerdictKind;
  severity: VerdictSeverity;
  reason: string;
  /** Unique per event: kept as the verdict's comment_id, so a redelivered event records nothing. */
  key: string;
  actor: Actor;
  pr_head: string | null;
}

/** Verdicts: a person's verdict, implicit verdicts (merges, pushes, reverts) and fix-forward links. */
export class VerdictsUnit {
  /** Reads change refs out of commit messages and item text: the selected forge, else the local forge (no call). */
  private readonly links: Pick<Forge, "parseLinks">;

  constructor(private readonly c: Ctx) {
    this.links = c.k.forge ?? new LocalForge(c.k.cfg.branch_prefix);
  }

  /**
   * Stores one implicit verdict (design §4), retrying on version conflicts. Changes no field but the version; a
   * verdict already stored for the key or the PR head is a no-op.
   */
  async recordImplicitVerdict(id: WorkItemId, v: ImplicitVerdict): Promise<void> {
    for (let i = 0; i < MAX_CONFLICT_RETRIES; i++) {
      const it = await this.c.k.reader.getWorkItem(id);
      if (!it) return;
      const r = await this.c.k.commitItem([], { kind: "verdict", input: {
        id, expected_version: it.version, actor: v.actor, verdict: v.verdict, severity: v.severity, reason: v.reason,
        comment_id: v.key, target: "pr", implicit: true, pr_head: v.pr_head,
      } });
      if (r.ok) {
        this.c.k.d.log.info("implicit verdict recorded", { work_item_id: id, verdict: v.verdict, version: r.item.version });
        return;
      }
      if (r.reason !== "version_conflict") return;
    }
    this.c.k.d.log.warn("implicit verdict gave up after conflicts", { work_item_id: id });
  }

  /**
   * A `/verdict` on a work item's issue or PR (design §4): stores one verdict and changes no field but the
   * version. Like the other commands: 👀 on the comment, and a refusal gets one reply on the issue keyed on
   * the comment id. A comment already stored is a silent no-op, so a redelivery never replies.
   */
  async handleVerdict(e: VerdictEvent): Promise<void> {
    const item = await this.verdictItem(e);
    if (!item) return;
    const principal = await this.c.unit("auth").authorize(e.approver, "record_verdict", item.id);
    const refusal = "refuse" in principal ? principal.refuse : await this.verdictFrom(item.id, { comment_id: e.comment_id, target: e.target.kind }, principal, e.args);
    await this.c.unit("outbox").markSeen(item.source, e.comment_id);
    if (refusal === null) return;
    // A refused comment that was stored before (e.g. a since-revoked permission) is not answered either.
    if ((await this.c.k.reader.listVerdicts(item.id)).some((v) => v.comment_id === e.comment_id)) return;
    this.c.k.d.log.info("command refused", { work_item_id: item.id, command: e.kind, reason: refusal });
    await this.c.unit("outbox").post(
      item,
      item.source,
      `\`/verdict\` was not applied: ${refusal}.`,
      `<!-- factory:refused:${e.comment_id} -->`,
    );
  }

  /** The work item a verdict names: by issue, or by the PR's head branch when that PR is the item's. */
  async verdictItem(e: VerdictEvent): Promise<WorkItem | null> {
    if (e.target.kind === "issue") return this.c.k.reader.getWorkItemBySource(e.target.source.type, e.target.source.id);
    const id = workItemIdFromBranch(e.target.head_branch, this.c.k.cfg.branch_prefix);
    const item = id ? await this.c.k.reader.getWorkItem(id as WorkItemId) : null;
    return item && (item.change_ref === null || item.change_ref === e.target.change_ref) ? item : null;
  }

  /** `/verdict <args>` parsed, then stored (recordVerdict); a malformed one is refused with the usage line. */
  async verdictFrom(id: WorkItemId, key: { comment_id: string; target: VerdictTarget }, principal: Principal, args: string): Promise<string | null> {
    const parsed = parseVerdict(args);
    return parsed.ok ? this.recordVerdict(id, key, principal, parsed.value) : parsed.refuse;
  }

  /**
   * Re-read → check → recordVerdict, retrying on version conflicts. `key`: the comment id (an app request's
   * `app-<seq>`) and where the verdict was written. Returns the refusal reason, else null.
   */
  async recordVerdict(
    id: WorkItemId,
    key: { comment_id: string; target: VerdictTarget },
    principal: Principal,
    v: ParsedVerdict,
  ): Promise<string | null> {
    for (let i = 0; i < MAX_CONFLICT_RETRIES; i++) {
      const it = await this.c.k.reader.getWorkItem(id);
      if (!it) return null;
      if ((await this.c.k.reader.listVerdicts(id)).some((x) => x.comment_id === key.comment_id)) return null;
      const closed = verdictRefusal(it);
      if (closed !== null) return closed;
      // A local item is judged on the item itself (its local merge, or no merge yet); any other needs its PR.
      if (it.change_ref === null && it.source.type !== LOCAL_SOURCE) return "the work item has no PR yet";
      const r = await this.c.k.commitItem([], { kind: "verdict", input: {
        id,
        expected_version: it.version,
        actor: { kind: "user", id: principal.user_id },
        ...v,
        comment_id: key.comment_id,
        target: key.target,
        implicit: false,
        // Replaces the implicit verdict on the same head, if any; an item with no PR has no PR head.
        pr_head: it.change_ref === null ? null : it.last_head_sha,
      } });
      if (r.ok) {
        this.c.k.d.log.info("verdict recorded", { work_item_id: id, verdict: v.verdict, severity: v.severity, version: r.item.version });
        return null;
      }
      if (r.reason !== "version_conflict") return null;
    }
    this.c.k.d.log.warn("verdict gave up after conflicts", { work_item_id: id });
    return null;
  }

  /**
   * A base-branch commit that reverts a factory merge: one `reverted` row on each original item it names,
   * by merge sha (`This reverts commit <sha>`) or by change ref (a `Revert ...` subject, in the forge's form). The
   * row changes no field. Dedupe key: (item, reason, reverting commit), checked inside decide so a conflict re-reads.
   */
  async recordReverts(e: BaseCommitEvent): Promise<void> {
    const links = this.links.parseLinks(e.message);
    const project = this.c.k.project();
    const targets = new Set<WorkItemId>();
    for (const sha of links.reverted_shas) {
      const it = await this.c.k.reader.getWorkItemByMergeSha(project, sha);
      if (it) targets.add(it.id);
    }
    for (const ref of links.reverted_refs) {
      const it = await this.c.k.reader.getWorkItemByPr(project, ref);
      if (it) targets.add(it.id);
    }
    const detail = { reverting_commit: e.sha, reverting_pr: refDetail(links.reverting_ref) };
    for (const id of targets) {
      await this.c.unit("transitions").decide(id, async (it) =>
        (await this.hasDetail(it.id, "reverted", "reverting_commit", e.sha))
          ? null
          : { patch: {}, actor: LINKS, reason: "reverted", detail },
      );
      // A merged factory PR also gets one implicit `reverted` verdict per reverting commit (design §4).
      const it = await this.c.k.reader.getWorkItem(id);
      if (it?.origin !== "factory" || it.close_reason !== "completed" || it.merge_sha === null) continue;
      await this.recordImplicitVerdict(id, {
        verdict: "reverted", severity: "major", reason: `reverted by commit ${e.sha}`, key: `implicit:reverted:${id}:${e.sha}`,
        actor: LINKS, pr_head: null,
      });
    }
  }

  /**
   * A new item that says `Fixes <ref>` or `Follow-up to <ref>`, where ref is a factory change (in the forge's form):
   * the first such change links. A numbered one becomes its `fixes_pr`, and the item with that change gets one
   * `fixed_forward` row. Refs that are not factory changes are ignored. Both steps are no-ops when already done.
   */
  async linkFixForward(id: WorkItemId, text: string): Promise<void> {
    const project = this.c.k.project();
    for (const ref of this.links.parseLinks(text).fix_refs) {
      const original = await this.c.k.reader.getWorkItemByPr(project, ref);
      if (!original || original.id === id) continue;
      const n = prNumber({ change_ref: ref });
      if (n !== null) {
        await this.c.unit("transitions").decide(id, (it) =>
          it.fixes_pr !== null
            ? null
            : { patch: { fixes_pr: n }, actor: LINKS, reason: "fixes_pr_linked", detail: { original_work_item_id: original.id } },
        );
        // An earlier delivery may have linked another change first; record the forward link only for the one kept.
        if ((await this.c.k.reader.getWorkItem(id))?.fixes_pr !== n) return;
      }
      await this.c.unit("transitions").decide(original.id, async (it) =>
        (await this.hasDetail(it.id, "fixed_forward", "fix_work_item_id", id))
          ? null
          : { patch: {}, actor: LINKS, reason: "fixed_forward", detail: { fix_work_item_id: id } },
      );
      return;
    }
  }

  async hasDetail(id: WorkItemId, reason: string, key: string, value: StateChangeDetail[string]): Promise<boolean> {
    return (await this.c.k.reader.listStateChanges(id)).some((c) => c.reason === reason && c.detail?.[key] === value);
  }
}

/** A change ref in a state-change detail: a numbered change as its number (as before change refs), else the ref. */
function refDetail(ref: string | null): string | number | null {
  return ref === null ? null : (prNumber({ change_ref: ref }) ?? ref);
}

declare module "../../router/unit.js" {
  interface UnitOperations {
    "verdicts": VerdictsUnit;
  }
}

export default controllerUnit({
  name: "verdicts",
  create: (c: Ctx) => new VerdictsUnit(c),
  events: {
    verdict_submitted: (u, e) => u.handleVerdict(e),
    base_commit: (u, e) => u.recordReverts(e),
  },
});
