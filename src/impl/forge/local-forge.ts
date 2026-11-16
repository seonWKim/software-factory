import { fixReferences, isRevertSubject, revertedShas, subjectOf, unique } from "../../core/links.js";
import type { SourceRef } from "../../core/types.js";
import type { BaseChecks, BasePushInput, ChangeLinks, Forge, ForgePollResult, PrChecks, PrMergeResult } from "../../interfaces/forge.js";
import { pushBaseToOrigin } from "../git/base-push.js";

/**
 * The local forge (docs/plugins/forge.md): changes live in the factory's own repository, named by their branch, so a
 * change ref is a branch name and an item's `change_url` stays null. It answers every read with nothing, makes no
 * PR write and no API call; it holds no state. The verdict unit reads links through it when config selects no forge.
 * Given the base branch (`merge_queue.push_base` on and an origin, local.plugin.ts) it has `pushBase`, the GitHub
 * forge's git push of the base to the factory repo's origin; without it, no `pushBase` and a local merge queues none.
 */
export class LocalForge implements Forge {
  readonly ref_type = "local_change";
  /** One change ref: the branch prefix and a branch name after it, ending on a word character (not on `.` or `/`). */
  private readonly ref: RegExp;
  /** The base push (design 05-sources, Local items); no property at all unless the base branch is given. */
  declare readonly pushBase?: (input: BasePushInput) => Promise<void>;

  constructor(branchPrefix: string, pushBaseBranch: string | null = null) {
    this.ref = new RegExp(`(${branchPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\w-]+(?:[./][\\w-]+)*)`);
    if (pushBaseBranch !== null) this.pushBase = (input) => pushBaseToOrigin(pushBaseBranch, input);
  }

  /** Reverted shas, the branches a `Revert` subject names (no reverting change: a local revert has none), fix refs. */
  parseLinks(message: string): ChangeLinks {
    const subject = subjectOf(message);
    const named = isRevertSubject(subject) ? [...subject.matchAll(new RegExp(this.ref.source, "g"))].map((m) => m[1]!) : [];
    return { reverted_shas: revertedShas(message), reverted_refs: unique(named), reverting_ref: null, fix_refs: fixReferences(message, this.ref) };
  }

  async poll(cursor: string | null): Promise<ForgePollResult> {
    return { events: [], next_cursor: cursor ?? "" };
  }

  prRef(pr: number): SourceRef {
    return { type: this.ref_type, id: String(pr), link: "" };
  }

  prNumberOf(ref: SourceRef): number | null {
    return ref.type === this.ref_type && /^\d+$/.test(ref.id) ? Number(ref.id) : null;
  }

  async postPrComment(): Promise<{ url: string | null }> {
    return { url: null };
  }

  async setPrStatus(): Promise<void> {}

  /** No checks run on a local change: passed, as for a forge change with no checks. */
  async prChecks(): Promise<PrChecks> {
    return { state: "passed" };
  }

  /** No checks run on the local base either: passed, so the CI gate never waits on a red base. */
  async baseChecks(): Promise<BaseChecks> {
    return { state: "passed", head_sha: null };
  }

  async prCheckResults(): Promise<[]> {
    return [];
  }

  async prFiles(): Promise<string[]> {
    return [];
  }

  async labelAddedBy(): Promise<null> {
    return null;
  }

  async commitAuthor(): Promise<null> {
    return null;
  }

  async commitsBetween(): Promise<null> {
    return null;
  }

  async closePr(): Promise<"not_open"> {
    return "not_open";
  }

  async mergePr(): Promise<PrMergeResult> {
    return { merged: false, refused: "the local forge has no change to merge: a local item merges with `factory merge <id>`" };
  }
}
