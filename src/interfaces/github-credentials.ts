import type { Secret } from "./secret-store.js";

/**
 * Where the factory's GitHub token comes from (docs/plugins.md, GitHubCredentials). Only GitHub tool
 * implementations (the client and the broker's push) call it; the token never leaves them.
 */
export interface GitHubCredentials {
  /** A token for the REST API and git over HTTPS. Null when the selected plugin's secret is not set. */
  token(): Promise<Secret | null>;
  /**
   * What the last token minted was granted, for `doctor`: only credentials that mint short-lived tokens (the
   * GitHub App) have one; GitHub's repo `permissions` field does not describe such tokens.
   */
  grant?(): { expires_at: Date; permissions: Readonly<Record<string, string>> } | null;
}
