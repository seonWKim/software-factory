import type { GitHubAccess, GitHubCredentials } from "../../interfaces/github-credentials.js";
import type { Secret, SecretStore } from "../../interfaces/secret-store.js";
import type { Contexts } from "../../plugin-api.js";
import { GitHubClient, clientOptions } from "./github-client.js";
import { GITHUB_TOKEN } from "./token.plugin.js";

/** A personal access token from the secret file, used as is. GitHub shows every write as its owner. */
export class TokenCredentials implements GitHubCredentials {
  constructor(private readonly secrets: SecretStore) {}

  token(): Promise<Secret | null> {
    return this.secrets.get(GITHUB_TOKEN);
  }
}

/** The token plugin's build: the token from the secret file, and the process's one client over it. */
export function tokenAccess(c: Contexts["github_auth"]): GitHubAccess {
  const credentials = new TokenCredentials(c.secrets);
  return { credentials, api: new GitHubClient(credentials, undefined, clientOptions(c.loaded.file.github, c.clock)) };
}
