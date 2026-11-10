import { fixReferences, isRevertSubject, revertedShas, subjectOf, unique } from "../../core/links.js";
import type { SourceRef } from "../../core/types.js";
import type { ChangeLinks, Forge, ForgePollResult, PrChecks, PrMergeResult } from "../../interfaces/forge.js";

/**
 * The local forge (docs/plugins/forge.md): changes live in the factory's own repository, named by their branch, so a
 * change ref is a branch name and an item's `change_url` stays null. It answers every read with nothing, makes no
 * write and no outbound call; it holds no state. The verdict unit reads links through it when config selects no forge.
 */
export class LocalForge implements Forge {
  readonly ref_type = "local_change";
  /** One change ref: the branch prefix and a branch name after it, ending on a word character (not on `.` or `/`). */
  private readonly ref: RegExp;

  constructor(branchPrefix: string) {
    this.ref = new RegExp(`(${branchPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\w-]+(?:[./][\\w-]+)*)`);
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
