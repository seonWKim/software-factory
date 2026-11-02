import type { GrantSource, GrantSubject, Role } from "../../interfaces/auth-provider.js";
import { type GitHubClient, GitHubError, type RepoRef } from "../github/github-client.js";

const APPROVER = new Set(["admin", "maintain", "write"]);
const REQUESTER = new Set(["triage", "read"]);

/**
 * Repository permission as a grant (design 2026-11-01): write, maintain or admin on the configured repository
 * gives `approver`, triage or read gives `requester`, anything else nothing. Asked for every GitHub account of
 * the user. One repository per factory today, so the project is not used. Denies nothing. The only code that
 * asks GitHub for a permission (tests/grants.test.ts checks it).
 */
export class GitHubPermissionGrant implements GrantSource {
  readonly remote = true;

  constructor(
    private readonly client: Pick<GitHubClient, "request">,
    private readonly repo: RepoRef,
  ) {}

  async denies(_subject: GrantSubject, _project: string | null): Promise<boolean> {
    return false;
  }

  async roles(subject: GrantSubject, _project: string | null): Promise<Role[]> {
    const out = new Set<Role>();
    for (const a of subject.accounts) {
      if (a.provider !== "github") continue;
      const perm = await this.permission(a.subject);
      if (APPROVER.has(perm)) out.add("approver");
      else if (REQUESTER.has(perm)) out.add("requester");
    }
    return [...out];
  }

  /** The account's permission on the repository; "none" when GitHub does not know it as a collaborator. */
  private async permission(id: string): Promise<string> {
    try {
      const user = await this.client.request<{ login: string }>("GET", `/user/${id}`);
      const perm = await this.client.request<{ permission: string }>(
        "GET",
        `/repos/${this.repo.owner}/${this.repo.name}/collaborators/${user.login}/permission`,
      );
      return perm.permission;
    } catch (err) {
      if (err instanceof GitHubError && (err.status === 404 || err.status === 403)) return "none";
      throw err;
    }
  }
}
