import type { GitHubCredentials } from "../../interfaces/github-credentials.js";

export interface RepoRef {
  owner: string;
  name: string;
}

/** A repository as GitHub knows it now: its permanent node ID and its current path (after any rename or move). */
export interface RepoIdentity {
  /** GitHub's global node ID, e.g. "R_kgDOabc123". Never changes with a rename or a transfer. */
  node_id: string;
  owner: string;
  name: string;
  /** The web host the repository lives on: "github.com", or a GitHub Enterprise Server host. */
  host: string;
}

/** The web host for an API base URL: api.github.com → github.com; GHES (https://<host>/api/v3) → <host>. */
export function webHost(baseUrl: string): string {
  const u = new URL(baseUrl);
  return u.host === "api.github.com" ? "github.com" : u.host;
}

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** REST client. The token comes from GitHubCredentials at call time and never leaves this class. */
export class GitHubClient {
  constructor(
    private readonly credentials: GitHubCredentials,
    private readonly baseUrl = "https://api.github.com",
  ) {}

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.send(method, path, body);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /**
   * The token's expiry from GitHub's `github-authentication-token-expiration` header.
   * null = the token never expires.
   */
  async tokenExpiration(repo: RepoRef): Promise<Date | null> {
    const res = await this.send("GET", `/repos/${repo.owner}/${repo.name}`);
    const header = res.headers.get("github-authentication-token-expiration");
    return header ? new Date(header.replace(" UTC", "Z").replace(" ", "T")) : null;
  }

  /**
   * The repository's node ID and current `owner/name`. GitHub redirects a renamed or moved repository's old
   * path to the new one, and fetch follows the redirect, so this returns the path as it is now. Read-only.
   */
  async repoIdentity(repo: RepoRef): Promise<RepoIdentity> {
    const r = await this.request<{ node_id?: unknown; full_name?: unknown }>("GET", `/repos/${repo.owner}/${repo.name}`);
    const full = typeof r?.full_name === "string" ? r.full_name.split("/") : [];
    if (typeof r?.node_id !== "string" || r.node_id === "" || full.length !== 2 || !full[0] || !full[1]) {
      throw new Error(`GitHub GET /repos/${repo.owner}/${repo.name} returned no node_id and full_name`);
    }
    return { node_id: r.node_id, owner: full[0], name: full[1], host: webHost(this.baseUrl) };
  }

  /** A PR's unified diff (base...head, as GitHub shows it). Read-only: one GET, nothing written. */
  async pullDiff(repo: RepoRef, number: number): Promise<string> {
    if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`not a PR number: ${number}`);
    const res = await this.send("GET", `/repos/${repo.owner}/${repo.name}/pulls/${number}`, undefined, "application/vnd.github.diff");
    return res.text();
  }

  private async send(method: string, path: string, body?: unknown, accept = "application/vnd.github+json"): Promise<Response> {
    const token = await this.credentials.token();
    if (!token) throw new Error("GitHub credentials missing from the secret file (SET_UP.md, plugins.github_auth)");
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Accept: accept,
        Authorization: `Bearer ${token.reveal()}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "software-factory",
        ...(body !== undefined && { "Content-Type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new GitHubError(res.status, `GitHub ${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
    }
    return res;
  }

  /** GETs up to `maxPages` pages of 100. */
  async list<T>(path: string, maxPages = 5): Promise<T[]> {
    const out: T[] = [];
    const sep = path.includes("?") ? "&" : "?";
    for (let page = 1; page <= maxPages; page++) {
      const batch = await this.request<T[]>("GET", `${path}${sep}per_page=100&page=${page}`);
      out.push(...batch);
      if (batch.length < 100) break;
    }
    return out;
  }

  /**
   * Posts at most one comment carrying `marker` (an HTML comment) on an issue or PR. `url` is the comment's
   * html_url: the new one's, or the existing one's when the marker is already there.
   */
  async commentOnce(
    repo: RepoRef,
    number: number,
    body: string,
    marker: string,
  ): Promise<{ created: boolean; url: string | null }> {
    const path = `/repos/${repo.owner}/${repo.name}/issues/${number}/comments`;
    const existing = (await this.list<{ body?: string; html_url?: string }>(path, 10)).find((c) => c.body?.includes(marker));
    if (existing) return { created: false, url: existing.html_url ?? null };
    const posted = await this.request<{ html_url?: string } | undefined>("POST", path, { body: `${body}\n\n${marker}` });
    return { created: true, url: posted?.html_url ?? null };
  }
}

export function issueNumberFromSourceId(sourceId: string): number {
  const n = Number(sourceId.split("#")[1]);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`not a GitHub issue source id: ${sourceId}`);
  return n;
}
