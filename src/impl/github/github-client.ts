import type { SecretStore } from "../../interfaces/secret-store.js";

export interface RepoRef {
  owner: string;
  name: string;
}

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** REST client. The token is read from SecretStore at call time and never leaves this class. */
export class GitHubClient {
  constructor(
    private readonly secrets: SecretStore,
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

  /** A PR's unified diff (base...head, as GitHub shows it). Read-only: one GET, nothing written. */
  async pullDiff(repo: RepoRef, number: number): Promise<string> {
    if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`not a PR number: ${number}`);
    const res = await this.send("GET", `/repos/${repo.owner}/${repo.name}/pulls/${number}`, undefined, "application/vnd.github.diff");
    return res.text();
  }

  private async send(method: string, path: string, body?: unknown, accept = "application/vnd.github+json"): Promise<Response> {
    const token = await this.secrets.get("GITHUB_TOKEN");
    if (!token) throw new Error("GITHUB_TOKEN missing from the secret file (SET_UP.md)");
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

  /** Posts at most one comment carrying `marker` (an HTML comment) on an issue or PR. */
  async commentOnce(repo: RepoRef, number: number, body: string, marker: string): Promise<{ created: boolean }> {
    const existing = await this.list<{ body?: string }>(`/repos/${repo.owner}/${repo.name}/issues/${number}/comments`, 10);
    if (existing.some((c) => c.body?.includes(marker))) return { created: false };
    await this.request("POST", `/repos/${repo.owner}/${repo.name}/issues/${number}/comments`, {
      body: `${body}\n\n${marker}`,
    });
    return { created: true };
  }
}

export function issueNumberFromSourceId(sourceId: string): number {
  const n = Number(sourceId.split("#")[1]);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`not a GitHub issue source id: ${sourceId}`);
  return n;
}
