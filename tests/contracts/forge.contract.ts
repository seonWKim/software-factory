// The Forge contract (RFC 0023 R2): what every Forge implementation does, the test fakes included, taken from the
// port's doc comments (src/interfaces/forge.ts) and what the controller and outbound rely on. A case that needs a
// PR, a check or a review runs only where the harness can set one up: the local forge has no PRs.
import { describe, expect, it } from "vitest";
import type { PrCheckResult, SourceRef } from "../../src/core/types.js";
import type { ExternalIdentity } from "../../src/interfaces/auth-provider.js";
import type { Forge, ForgeEvent } from "../../src/interfaces/forge.js";

/** One forge under test and the hooks that set up and read its world. */
export interface ForgeHarness {
  forge: Forge;
  /** Change ref `n` as a commit message names it (`text`), and as `parseLinks` gives it back (`ref`). */
  changeRef(n: number): { text: string; ref: string };
  /** Opens PR `n` from factory branch `branch` at head `head`. Absent: this forge has no PRs. */
  openPr?(n: number, branch: string, head: string): Promise<void>;
  /** The PR comments on PR `n` carrying `marker`. */
  prComments?(n: number, marker: string): Promise<string[]>;
  /** The factory status markers PR `n` carries now. Absent: the forge shows no PR status. */
  prStatus?(n: number): Promise<string[]>;
  /** Sets the checks on PR `n`'s head commit. */
  checks?(n: number, results: PrCheckResult[]): Promise<void>;
  /** A person submits a "Request changes" review `review_id` on PR `n`. */
  requestChanges?(n: number, review_id: number, reviewer: ExternalIdentity): Promise<void>;
  /** Source item `item` was closed by `closer`. */
  closeItem?(item: SourceRef, closer: ExternalIdentity): Promise<void>;
  /** `who` adds label `label` to PR `n`. */
  addLabel?(n: number, label: string, who: ExternalIdentity): Promise<void>;
  /** Commit `sha` exists, its author linked to `author` (null: to no account). */
  commit?(sha: string, author: ExternalIdentity | null): Promise<void>;
  /** The forge can count the commits from `from` to `to`: `count`. */
  between?(from: string, to: string, count: number): Promise<void>;
}

const SHA_A = "a".repeat(40);
const SHA_B = "1".repeat(40);
/** A person, as GitHub names one (the only forge whose identities the fakes stand in for). */
const ALICE: ExternalIdentity = { provider: "github", subject: "1", login: "alice" };
const BOB: ExternalIdentity = { provider: "github", subject: "2", login: "bob" };
const ITEM: SourceRef = { type: "github_issue", id: "o/r#3", link: "https://github.com/o/r/issues/3" };

const kinds = (events: ForgeEvent[], kind: ForgeEvent["kind"], change_ref: string) => events.filter((e) => e.kind === kind && e.change_ref === change_ref);

export function forgeContract(name: string, make: () => Promise<ForgeHarness>): void {
  describe(`Forge contract: ${name}`, () => {
    describe("PR refs", () => {
      it("prNumberOf reads back the number of its own prRef, whose type is ref_type (the outbox routes PR comments by it)", async () => {
        const { forge } = await make();
        for (const n of [1, 42, 1234]) {
          expect(forge.prRef(n).type).toBe(forge.ref_type);
          expect(forge.prNumberOf(forge.prRef(n))).toBe(n);
        }
      });

      it("prNumberOf is null for a ref of another source type: an issue is never taken for a PR", async () => {
        const { forge } = await make();
        const other = forge.ref_type === "slack_thread" ? "github_issue" : "slack_thread";
        expect(forge.prNumberOf({ ...forge.prRef(5), type: other })).toBeNull();
      });

      it("prNumberOf is null for a ref whose id is not its prRef's: another repository's PR is not this forge's", async () => {
        const { forge } = await make();
        const ref = forge.prRef(5);
        expect(forge.prNumberOf({ ...ref, id: `elsewhere/${ref.id}` })).toBeNull();
      });
    });

    describe("parseLinks", () => {
      it("gives each reverted sha once, lowercased, and is pure: the same message gives the same links", async () => {
        const { forge } = await make();
        const sha = "ABCDEF1234567";
        const msg = `Revert "x"\n\nThis reverts commit ${sha}.\nThis reverts commit ${sha.toLowerCase()}.`;
        expect(forge.parseLinks(msg).reverted_shas).toEqual([sha.toLowerCase()]);
        expect(forge.parseLinks(msg)).toEqual(forge.parseLinks(msg));
      });

      it("gives the refs of Fixes and Follow-up to in order of first mention, each once", async () => {
        const h = await make();
        const [a, b] = [h.changeRef(12), h.changeRef(13)];
        const links = h.forge.parseLinks(`Tidy up\n\nFollow-up to ${b.text}\nFixes ${a.text}\nFixes ${b.text}`);
        expect(links.fix_refs).toEqual([b.ref, a.ref]);
      });

      it("gives the refs a Revert subject names as reverted refs, and nothing for a plain message", async () => {
        const h = await make();
        const a = h.changeRef(12);
        expect(h.forge.parseLinks(`Revert "Add y" ${a.text}`).reverted_refs).toEqual([a.ref]);
        expect(h.forge.parseLinks(`Add y ${a.text}\n\nmore text`)).toEqual({ reverted_shas: [], reverted_refs: [], reverting_ref: null, fix_refs: [] });
      });
    });

    describe("poll", () => {
      it("gives a string cursor that the next poll takes", async () => {
        const { forge } = await make();
        const first = await forge.poll(null);
        expect(typeof first.next_cursor).toBe("string");
        expect(typeof (await forge.poll(first.next_cursor)).next_cursor).toBe("string");
      });

      it("reports an open factory PR on every poll while it is open, with its head", async (ctx) => {
        const h = await make();
        if (!h.openPr) return ctx.skip();
        await h.openPr(7, "factory/wi_a", SHA_A);
        const first = await h.forge.poll(null);
        const second = await h.forge.poll(first.next_cursor);
        for (const r of [first, second]) {
          expect(kinds(r.events, "change_open", "7")).toEqual([expect.objectContaining({ head_branch: "factory/wi_a", head_sha: SHA_A, source: h.forge.prRef(7) })]);
        }
      });

      it("never delivers one review twice across polls that advanced the cursor", async (ctx) => {
        const h = await make();
        if (!h.openPr || !h.requestChanges) return ctx.skip();
        await h.openPr(7, "factory/wi_a", SHA_A);
        const first = await h.forge.poll(null);
        await h.requestChanges(7, 900, BOB);
        const second = await h.forge.poll(first.next_cursor);
        const third = await h.forge.poll(second.next_cursor);
        expect(kinds(second.events, "pr_changes_requested", "7")).toEqual([
          expect.objectContaining({ review_id: "900", head_branch: "factory/wi_a", reviewer: expect.objectContaining({ subject: BOB.subject }) }),
        ]);
        expect(kinds(third.events, "pr_changes_requested", "7")).toEqual([]);
      });
    });

    describe("PR comments and status", () => {
      it("postPrComment posts once per marker and answers the same link both times", async () => {
        const h = await make();
        await h.openPr?.(7, "factory/wi_a", SHA_A);
        const first = await h.forge.postPrComment(7, "hello", "<!-- m1 -->");
        const again = await h.forge.postPrComment(7, "hello again", "<!-- m1 -->");
        expect(again.url).toBe(first.url);
        if (h.prComments) expect(await h.prComments(7, "<!-- m1 -->")).toHaveLength(1);
      });

      it("postPrComment posts a comment per marker: another marker is another comment", async (ctx) => {
        const h = await make();
        if (!h.openPr || !h.prComments) return ctx.skip();
        await h.openPr(7, "factory/wi_a", SHA_A);
        const a = await h.forge.postPrComment(7, "one", "<!-- m1 -->");
        const b = await h.forge.postPrComment(7, "two", "<!-- m2 -->");
        expect(b.url).not.toBe(a.url);
        expect(await h.prComments(7, "<!-- m2 -->")).toHaveLength(1);
      });

      it("setPrStatus leaves exactly one factory status on the PR, the last one set", async (ctx) => {
        const h = await make();
        if (!h.openPr || !h.prStatus) return ctx.skip();
        await h.openPr(7, "factory/wi_a", SHA_A);
        await h.forge.setPrStatus(ITEM, "implementing", 7);
        await h.forge.setPrStatus(ITEM, "in_review", 7);
        await h.forge.setPrStatus(ITEM, "in_review", 7);
        expect(await h.prStatus(7)).toEqual(["in_review"]);
      });
    });

    describe("checks", () => {
      it("a PR head with no checks has passed, and lists none", async () => {
        const h = await make();
        await h.openPr?.(7, "factory/wi_a", SHA_A);
        await h.checks?.(7, []);
        expect(await h.forge.prChecks(7)).toEqual({ state: "passed" });
        expect(await h.forge.prCheckResults(7)).toEqual([]);
      });

      it("prChecks sums prCheckResults up: any failed check fails it, with the failed names", async (ctx) => {
        const h = await make();
        if (!h.openPr || !h.checks) return ctx.skip();
        await h.openPr(7, "factory/wi_a", SHA_A);
        const results: PrCheckResult[] = [{ name: "lint", result: "passed" }, { name: "test", result: "failed" }, { name: "e2e", result: "pending" }];
        await h.checks(7, results);
        expect(await h.forge.prCheckResults(7)).toEqual(results);
        expect(await h.forge.prChecks(7)).toEqual({ state: "failed", failed: ["test"] });
      });

      it("prChecks is pending while a check runs and none failed", async (ctx) => {
        const h = await make();
        if (!h.openPr || !h.checks) return ctx.skip();
        await h.openPr(7, "factory/wi_a", SHA_A);
        await h.checks(7, [{ name: "lint", result: "passed" }, { name: "test", result: "pending" }]);
        expect(await h.forge.prChecks(7)).toEqual({ state: "pending" });
      });
    });

    describe("closePr", () => {
      const input = (marker = "<!-- close -->") => ({
        pr: 7, closed: ITEM, marker, body: (closer: ExternalIdentity | null) => `closed by ${closer?.login ?? "nobody"}`,
      });

      it("leaves a PR that is not open alone, with no comment", async () => {
        const h = await make();
        if (h.openPr) {
          await h.openPr(7, "factory/wi_a", SHA_A);
          expect(await h.forge.closePr(input("<!-- first -->"))).toBe("closed");
        }
        expect(await h.forge.closePr(input())).toBe("not_open");
        if (h.prComments) expect(await h.prComments(7, "<!-- close -->")).toEqual([]);
      });

      it("comments once with who closed the item, then closes the open PR; a second call finds it not open", async (ctx) => {
        const h = await make();
        if (!h.openPr || !h.prComments || !h.closeItem) return ctx.skip();
        await h.openPr(7, "factory/wi_a", SHA_A);
        await h.closeItem(ITEM, ALICE);
        expect(await h.forge.closePr(input())).toBe("closed");
        expect(await h.forge.closePr(input())).toBe("not_open");
        const posted = await h.prComments(7, "<!-- close -->");
        expect(posted).toHaveLength(1);
        expect(posted[0]).toContain("closed by alice");
      });
    });

    describe("mergePr", () => {
      it("merges a PR at the reviewed head; a retry answers the same merge commit as already merged", async (ctx) => {
        const h = await make();
        if (!h.openPr) return ctx.skip();
        await h.openPr(7, "factory/wi_a", SHA_A);
        const first = await h.forge.mergePr(7, SHA_A, "merge");
        expect(first).toMatchObject({ merged: true, already: false });
        const again = await h.forge.mergePr(7, SHA_A, "merge");
        expect(again).toEqual({ merged: true, sha: (first as { sha: string }).sha, already: true });
      });

      it("refuses a head that moved since the review, and nothing moves: the PR still merges at its head", async (ctx) => {
        const h = await make();
        if (!h.openPr) return ctx.skip();
        await h.openPr(7, "factory/wi_a", SHA_A);
        const refused = await h.forge.mergePr(7, SHA_B, "merge");
        expect(refused.merged).toBe(false);
        expect(refused).toEqual({ merged: false, refused: expect.any(String) });
        expect(await h.forge.mergePr(7, SHA_A, "merge")).toMatchObject({ merged: true, already: false });
      });
    });

    describe("reads", () => {
      it("labelAddedBy names who added the label, and null for a label nobody added", async () => {
        const h = await make();
        await h.openPr?.(7, "factory/wi_a", SHA_A);
        if (h.addLabel) {
          await h.addLabel(7, "merge", ALICE);
          expect(await h.forge.labelAddedBy(7, "merge")).toMatchObject({ subject: ALICE.subject });
        }
        expect(await h.forge.labelAddedBy(7, "never-added")).toBeNull();
      });

      it("commitAuthor names the linked account, and null for a commit linked to none", async () => {
        const h = await make();
        if (h.commit) {
          await h.commit(SHA_A, ALICE);
          expect(await h.forge.commitAuthor(SHA_A)).toMatchObject({ subject: ALICE.subject });
          await h.commit(SHA_B, null);
        }
        expect(await h.forge.commitAuthor(SHA_B)).toBeNull();
      });

      it("commitsBetween counts the commits it can, and is null (never a throw) for shas it cannot compare", async () => {
        const h = await make();
        if (h.between) {
          await h.between(SHA_A, SHA_B, 3);
          expect(await h.forge.commitsBetween(SHA_A, SHA_B)).toBe(3);
        }
        expect(await h.forge.commitsBetween("f".repeat(40), SHA_B)).toBeNull();
      });
    });

    describe("openPr", () => {
      it("opens the branch's PR once: a second call updates the open one instead of opening another", async (ctx) => {
        const h = await make();
        if (!h.forge.openPr) return ctx.skip();
        const input = { branch: "factory/wi_b", base_ref: "main", title: "t", body: "b" };
        const first = await h.forge.openPr(input);
        const again = await h.forge.openPr({ ...input, title: "t2" });
        expect(again.number).toBe(first.number);
        expect(h.forge.prNumberOf(h.forge.prRef(first.number))).toBe(first.number);
      });
    });
  });
}
