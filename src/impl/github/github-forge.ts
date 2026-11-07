import type { Forge } from "../../interfaces/forge.js";
import type { GitHubIssueSource } from "../source/github-issue-source.js";

/** The PR facts GitHubForge reads; GitHubIssueSource has them today (issue #172 moves them in a later phase). */
export type GitHubPrFacts = Pick<GitHubIssueSource, "prChecks" | "prFiles" | "commitAuthor" | "closePr">;

/**
 * The GitHub forge. Phase 1 of issue #172: each PR fact passes through to the GitHub issue source's method of
 * the same name, so the two can never disagree while the controller still reads them from the source.
 */
export class GitHubForge implements Forge {
  constructor(private readonly facts: GitHubPrFacts) {}

  prChecks(pr_number: number): ReturnType<Forge["prChecks"]> {
    return this.facts.prChecks(pr_number);
  }
  prFiles(pr_number: number): ReturnType<Forge["prFiles"]> {
    return this.facts.prFiles(pr_number);
  }
  commitAuthor(sha: string): ReturnType<Forge["commitAuthor"]> {
    return this.facts.commitAuthor(sha);
  }
  closePr(input: Parameters<Forge["closePr"]>[0]): ReturnType<Forge["closePr"]> {
    return this.facts.closePr(input);
  }
}
