import type { UserId } from "../../core/types.js";
import type {
  AuthAction,
  AuthDecision,
  AuthProvider,
  AuthResource,
  ExternalIdentity,
  Principal,
} from "../../interfaces/auth-provider.js";
import { type GitHubClient, GitHubError, type RepoRef } from "../github/github-client.js";

const WRITE = new Set(["admin", "maintain", "write"]);

/**
 * Repository permission as the authorization source. Submitting work needs no check here: only
 * users with triage access can apply the intake label. Approvals need write access. Deny by default.
 */
export class GitHubAuthProvider implements AuthProvider {
  constructor(
    private readonly client: GitHubClient,
    private readonly repo: RepoRef,
  ) {}

  async resolve(identity: ExternalIdentity): Promise<Principal | null> {
    if (identity.provider !== "github") return null;
    return { user_id: `github:${identity.subject}` as UserId, attributes: {} };
  }

  async authorize(principal: Principal, action: AuthAction, _resource: AuthResource): Promise<AuthDecision> {
    if (action === "submit_work") return { allow: true };
    const id = principal.user_id.replace(/^github:/, "");
    try {
      const user = await this.client.request<{ login: string }>("GET", `/user/${id}`);
      const perm = await this.client.request<{ permission: string }>(
        "GET",
        `/repos/${this.repo.owner}/${this.repo.name}/collaborators/${user.login}/permission`,
      );
      return WRITE.has(perm.permission) ? { allow: true } : { allow: false, reason: `permission:${perm.permission}` };
    } catch (err) {
      if (err instanceof GitHubError && (err.status === 404 || err.status === 403)) {
        return { allow: false, reason: "not_a_collaborator" };
      }
      throw err;
    }
  }
}

/** Local dev only, on a private repo. Allows everything. */
export class NoAuthProvider implements AuthProvider {
  async resolve(identity: ExternalIdentity): Promise<Principal | null> {
    return { user_id: `${identity.provider}:${identity.subject}` as UserId, attributes: {} };
  }
  async authorize(): Promise<AuthDecision> {
    return { allow: true };
  }
}
