// GitHub API fakes (RFC 0023 R4): credentials, PR diffs, and a GitHubClient over in-memory issues.
import { GitHubClient, GitHubError } from "../../../src/impl/github/github-client.js";
import type { GitHubAccess, GitHubApi, GitHubCredentials } from "../../../src/interfaces/github-credentials.js";

/**
 * A github_auth plugin's build for tests: `credentials`, and `api` (absent: a client over them whose calls go to
 * the global fetch, which a test stubs; never a live call).
 */
export function fakeGitHubAccess(credentials: GitHubCredentials, api: GitHubApi = new GitHubClient(credentials)): GitHubAccess {
  return { credentials, api };
}

/** Read-only PR diffs by number, standing in for GitHubClient.pullDiff. Records every PR asked for. */
export class FakeGitHubDiff {
  calls: number[] = [];
  constructor(private readonly diffs: Record<number, string>) {}
  async pullDiff(pr: number): Promise<string> {
    this.calls.push(pr);
    const d = this.diffs[pr];
    if (d === undefined) throw new Error(`no diff for PR ${pr}`);
    return d;
  }
}

/**
 * A GitHubClient over in-memory issues of repo o/r: the label and comment routes the GitHub source's
 * setStatus and postComment use. Every request is recorded in `calls` as `METHOD path` (query dropped).
 */
export class FakeGitHubClient extends GitHubClient {
  calls: string[] = [];
  /** Labels per issue or PR number. */
  labels = new Map<number, string[]>();
  /** Comments per issue or PR number. */
  comments = new Map<number, { id: number; body: string; html_url: string }[]>();
  /** When set, a comment POST throws this. */
  commentError: Error | null = null;
  /** The head sha of each PR (`GET /pulls/N`), and the check runs and commit statuses of each sha. */
  pullHeads = new Map<number, string>();
  checkRuns = new Map<string, { name: string; status: string; conclusion: string | null }[]>();
  statuses = new Map<string, { context: string; state: string }[]>();
  private nextId = 1;

  constructor() {
    super({} as GitHubCredentials, "http://unused");
  }

  /** The calls to one issue's or PR's label routes. */
  labelCalls(n?: number): string[] {
    return this.calls.filter((c) => (n === undefined ? /\/issues\/\d+\/labels/ : new RegExp(`/issues/${n}/labels`)).test(c));
  }

  override async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const [bare, query = ""] = path.split("?") as [string, string?];
    this.calls.push(`${method} ${bare}`);
    const firstPage = !/(^|&)page=([2-9]|\d\d)/.test(query);
    if (method === "POST" && bare === "/repos/o/r/labels") return {} as T;
    let m = /^\/repos\/o\/r\/issues\/(\d+)\/labels$/.exec(bare);
    if (m) {
      const n = Number(m[1]);
      const have = this.labels.get(n) ?? [];
      if (method === "GET") return (firstPage ? have.map((name) => ({ name })) : []) as T;
      for (const l of (body as { labels: string[] }).labels) if (!have.includes(l)) have.push(l);
      this.labels.set(n, have);
      return [] as T;
    }
    m = /^\/repos\/o\/r\/issues\/(\d+)\/labels\/(.+)$/.exec(bare);
    if (m && method === "DELETE") {
      const n = Number(m[1]);
      const name = decodeURIComponent(m[2]!);
      const have = this.labels.get(n) ?? [];
      if (!have.includes(name)) throw new GitHubError(404, `GitHub DELETE ${bare} → 404`);
      this.labels.set(n, have.filter((l) => l !== name));
      return undefined as T;
    }
    m = /^\/repos\/o\/r\/issues\/(\d+)\/comments$/.exec(bare);
    if (m) {
      const n = Number(m[1]);
      const thread = this.comments.get(n) ?? [];
      if (method === "GET") return (firstPage ? thread : []) as T;
      if (this.commentError) throw this.commentError;
      const id = this.nextId++;
      const c = { id, body: (body as { body: string }).body, html_url: `https://github.com/o/r/issues/${n}#issuecomment-${id}` };
      this.comments.set(n, [...thread, c]);
      return c as T;
    }
    m = /^\/repos\/o\/r\/pulls\/(\d+)$/.exec(bare);
    const head = m && this.pullHeads.get(Number(m[1]));
    if (method === "GET" && head) return { number: Number(m![1]), head: { ref: "factory/wi_a", sha: head } } as T;
    m = /^\/repos\/o\/r\/commits\/([^/]+)\/(check-runs|status)$/.exec(bare);
    if (method === "GET" && m) {
      const runs = this.checkRuns.get(m[1]!) ?? [];
      if (m[2] === "check-runs") return { total_count: runs.length, check_runs: firstPage ? runs : [] } as T;
      return { statuses: this.statuses.get(m[1]!) ?? [] } as T;
    }
    throw new Error(`unexpected ${method} ${path}`);
  }
}
