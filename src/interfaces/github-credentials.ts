import type { GitHubBudgetStatus } from "../core/controller.js";
import type { Secret } from "./secret-store.js";

/**
 * Where the factory's forge token comes from (docs/plugins.md, GitHubCredentials). Only forge tool
 * implementations (the client and the broker's push) call it; the token never leaves them.
 */
export interface GitHubCredentials {
  /** A token for the REST API and git over HTTPS. Null when the selected plugin's secret is not set. */
  token(): Promise<Secret | null>;
  /**
   * What the last token minted was granted, for `doctor`: only credentials that mint short-lived tokens (an
   * app installation) have one; the forge's repo `permissions` field does not describe such tokens.
   */
  grant?(): { expires_at: Date; permissions: Readonly<Record<string, string>> } | null;
}

/** A repository by its path on the forge. */
export interface RepoPath {
  owner: string;
  name: string;
}

/** A repository as the forge knows it now: its permanent node ID and its current path (after any rename or move). */
export interface RepoIdentity extends RepoPath {
  /** The forge's global node ID. Never changes with a rename or a transfer. */
  node_id: string;
  /** The web host the repository lives on. */
  host: string;
}

/**
 * The forge's REST client as plugins see it: the calls they make, the token kept inside. One per process,
 * built by the selected credential plugin (docs/plugins.md, GitHubCredentials), so its rate-limit budget and
 * conditional-request cache are shared by every plugin that calls the forge.
 */
export interface GitHubApi {
  request<T>(method: string, path: string, body?: unknown): Promise<T>;
  /** GETs up to `maxPages` pages of 100; stops early after a page for which `done` is true. */
  list<T>(path: string, maxPages?: number, done?: (page: T[]) => boolean): Promise<T[]>;
  /** Posts at most one comment carrying `marker`; `url` is the new or the existing comment's. */
  commentOnce(repo: RepoPath, number: number, body: string, marker: string): Promise<{ created: boolean; url: string | null }>;
  /** The token's expiry; null: it never expires. */
  tokenExpiration(repo: RepoPath): Promise<Date | null>;
  repoIdentity(repo: RepoPath): Promise<RepoIdentity>;
  /** A change's unified diff. Read-only. */
  pullDiff(repo: RepoPath, number: number): Promise<string>;
  /** True while optional reads should wait for the rate-limit reset. */
  lowBudget(): boolean;
  /** Takes up to `n` catch-up reads from this minute's allowance; returns how many it took. */
  takeCatchUp(n: number): number;
  /** The rate-limit budget as the status page shows it; null before any response carried it. */
  status(): GitHubBudgetStatus | null;
}

/** What a credential plugin builds: the credentials, and the one client over them. */
export interface GitHubAccess {
  /** Only the broker gets these (its git push); every other plugin gets `api`. */
  credentials: GitHubCredentials;
  api: GitHubApi;
}
