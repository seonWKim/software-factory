import type { GitHubCredentials } from "../../interfaces/github-credentials.js";
import { type Secret, type SecretStore, secretName } from "../../interfaces/secret-store.js";

export const GITHUB_TOKEN = secretName("GITHUB_TOKEN");

/** A personal access token from the secret file, used as is. GitHub shows every write as its owner. */
export class TokenCredentials implements GitHubCredentials {
  constructor(private readonly secrets: SecretStore) {}

  token(): Promise<Secret | null> {
    return this.secrets.get(GITHUB_TOKEN);
  }
}
