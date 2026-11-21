// The Forge contract (tests/contracts/forge.contract.ts) over every implementation: the local forge, the GitHub forge
// on an in-memory GitHub, and the test fake the feature tests use (RFC 0023 R2).
import type { WorkStatus } from "../../src/core/status-label.js";
import type { ExternalIdentity } from "../../src/interfaces/auth-provider.js";
import { LocalForge } from "../../src/impl/forge/local-forge.js";
import { GitHubForge } from "../../src/impl/github/github-forge.js";
import { GitHubIssueSource, statusLabels } from "../../src/impl/github/github-issue-source.js";
import { FakeForge } from "../helpers/fakes/forge.js";
import { FakeSource } from "../helpers/fakes/source.js";
import { pollContext } from "../helpers/github.js";
import { newStore } from "../helpers/store.js";
import { forgeContract } from "./forge.contract.js";
import { MemoryGitHub, type MemUser } from "./memory-github.js";

const user = (who: ExternalIdentity): MemUser => ({ id: Number(who.subject), login: who.login ?? "", type: "User" });

forgeContract("local", async () => ({
  forge: new LocalForge("factory/"),
  changeRef: (n) => ({ text: `factory/wi_${n}`, ref: `factory/wi_${n}` }),
}));

forgeContract("github", async () => {
  const gh = new MemoryGitHub();
  const repo = { owner: "o", name: "r" };
  const { store } = await newStore();
  // The source item the contract's PRs belong to (ITEM, o/r#3): closePr reads who closed it.
  gh.addIssue({ number: 3 });
  const issues = new GitHubIssueSource(gh, repo, "factory", "factory/", "main", "sf: ", store);
  const forge = new GitHubForge(gh, repo, "factory/", "main", issues, pollContext());
  const status = new Map(statusLabels("sf: ").map((l) => [l.name, l.status] as [string, WorkStatus]));
  return {
    forge,
    changeRef: (n) => ({ text: `#${n}`, ref: String(n) }),
    async openPr(n, branch, head) {
      gh.addPull(n, { ref: branch, sha: head });
    },
    async prComments(n, marker) {
      return gh.comments.filter((c) => c.number === n && c.body.includes(marker)).map((c) => c.body);
    },
    async prStatus(n) {
      return gh.issue(n).labels.flatMap((l) => (status.has(l) ? [status.get(l)!] : []));
    },
    async checks(n, results) {
      gh.checkRuns.set(gh.issue(n).pull!.head.sha, results.map((r) => ({
        name: r.name,
        status: r.result === "pending" ? "in_progress" : "completed",
        conclusion: r.result === "pending" ? null : r.result === "passed" ? "success" : "failure",
      })));
    },
    async requestChanges(n, review_id, reviewer) {
      const i = gh.issue(n);
      const at = gh.tick();
      i.pull!.reviews.push({ id: review_id, state: "CHANGES_REQUESTED", body: "please change", user: user(reviewer), submitted_at: at });
      i.updated_at = at;
    },
    async closeItem(item, closer) {
      const n = Number(item.id.split("#")[1]);
      const i = gh.issues.get(n) ?? gh.addIssue({ number: n });
      Object.assign(i, { state: "closed", state_reason: "completed", closed_by: user(closer) });
    },
    async addLabel(n, label, who) {
      const i = gh.issue(n);
      i.labels.push(label);
      i.timeline.push({ event: "labeled", label: { name: label }, actor: user(who) });
    },
    async commit(sha, author) {
      gh.commits.set(sha, author ? user(author) : null);
    },
    async between(from, to, count) {
      gh.compare.set(`${from}...${to}`, count);
    },
  };
});

forgeContract("fake", async () => {
  const source = new FakeSource();
  const forge = new FakeForge(source);
  return {
    forge,
    changeRef: (n) => ({ text: `#${n}`, ref: String(n) }),
    async openPr(n, branch, head) {
      forge.prHeads[n] = head;
      forge.openPrs.set(n, {
        kind: "change_open", source: forge.prRef(n), change_ref: String(n), head_branch: branch, head_sha: head, title: `PR ${n}`, body: "",
        author: null, labels: [],
      });
    },
    async prComments(n, marker) {
      return [...forge.comments, ...forge.prComments].filter((c) => c.pr_number === n && c.marker === marker).map((c) => c.body);
    },
    async prStatus(n) {
      const s = forge.prStatus(n);
      return s ? [s] : [];
    },
    async checks(_n, results) {
      forge.checkList = results;
    },
    async requestChanges(n, review_id, reviewer) {
      const head_branch = forge.openPrs.get(n)?.head_branch ?? "";
      forge.queue.push({
        kind: "pr_changes_requested", source: forge.prRef(n), change_ref: String(n), head_branch, review_id: String(review_id), reviewer,
        body: "please change", comments: [],
      });
    },
    async closeItem(item, closer) {
      source.closers.set(item.id, closer);
    },
    async addLabel(n, label, who) {
      forge.labelAdders[`${n}:${label}`] = who;
    },
    async commit(sha, author) {
      if (author) forge.commitAuthors[sha] = author;
    },
    async between(from, to, count) {
      forge.commitCounts[`${from}..${to}`] = count;
    },
  };
});
