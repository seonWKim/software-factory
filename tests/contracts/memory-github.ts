// An in-memory GitHub repository o/r behind GitHubClient (RFC 0023 R2): the REST routes the GitHub forge and the
// GitHub issue source call, answered from state the contract suites set up and read back. Never the network.
import { GitHubClient, GitHubError } from "../../src/impl/github/github-client.js";
import type { GitHubCredentials } from "../../src/interfaces/github-credentials.js";

export interface MemUser {
  id: number;
  login: string;
  type: "User" | "Bot";
}

interface MemIssue {
  id: number;
  number: number;
  title: string;
  body: string;
  user: MemUser;
  state: "open" | "closed";
  state_reason: string | null;
  closed_by: MemUser | null;
  labels: string[];
  updated_at: string;
  created_at: string;
  /** Set on a PR: issues and PRs share numbers, labels and comments, as on GitHub. */
  pull?: MemPull;
  sub_issues: number[];
  reactions: string[];
  timeline: { event: string; label?: { name: string }; actor: MemUser }[];
}

interface MemPull {
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  merged_at: string | null;
  merge_commit_sha: string | null;
  merged_by: MemUser | null;
  draft: boolean;
  reviews: { id: number; state: string; body: string; user: MemUser; submitted_at: string }[];
}

interface MemComment {
  id: number;
  number: number;
  body: string;
  user: MemUser;
  updated_at: string;
  reactions: string[];
}

const BOT: MemUser = { id: 99, login: "factory[bot]", type: "Bot" };
const R = "/repos/o/r";

export class MemoryGitHub extends GitHubClient {
  issues = new Map<number, MemIssue>();
  comments: MemComment[] = [];
  /** Check runs and commit statuses per sha. */
  checkRuns = new Map<string, { name: string; status: string; conclusion: string | null }[]>();
  statuses = new Map<string, { context: string; state: string }[]>();
  /** Commits by sha: the account their author is linked to (null: none). */
  commits = new Map<string, MemUser | null>();
  /** `ahead_by` per `from...to`. */
  compare = new Map<string, number>();
  private n = 0;
  private ids = 1000;
  private t = Date.parse("2026-02-01T00:00:00Z");

  constructor() {
    super({} as GitHubCredentials, "http://unused");
  }

  /** A later time than any before, in GitHub's format. */
  tick(): string {
    this.t += 1000;
    return new Date(this.t).toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  issue(n: number): MemIssue {
    const i = this.issues.get(n);
    if (!i) throw new GitHubError(404, `GitHub: no issue ${n}`);
    return i;
  }

  addIssue(o: { title?: string; body?: string; labels?: string[]; user?: MemUser; number?: number } = {}): MemIssue {
    const number = o.number ?? ++this.n;
    this.n = Math.max(this.n, number);
    const at = this.tick();
    const i: MemIssue = {
      id: ++this.ids, number, title: o.title ?? `issue ${number}`, body: o.body ?? "", user: o.user ?? { id: 1, login: "alice", type: "User" },
      state: "open", state_reason: null, closed_by: null, labels: [...(o.labels ?? [])], updated_at: at, created_at: at,
      sub_issues: [], reactions: [], timeline: [],
    };
    this.issues.set(number, i);
    return i;
  }

  addPull(number: number, head: { ref: string; sha: string }, base = "main"): MemIssue {
    const i = this.addIssue({ number, title: `PR ${number}` });
    i.pull = { head, base: { ref: base, sha: "b".repeat(40) }, merged_at: null, merge_commit_sha: null, merged_by: null, draft: false, reviews: [] };
    return i;
  }

  addComment(number: number, body: string, user: MemUser = { id: 1, login: "alice", type: "User" }): MemComment {
    const c: MemComment = { id: ++this.ids, number, body, user, updated_at: this.tick(), reactions: [] };
    this.comments.push(c);
    this.issue(number).updated_at = c.updated_at;
    return c;
  }

  private commentJson(c: MemComment) {
    const kind = this.issues.get(c.number)?.pull ? "pull" : "issues";
    return {
      id: c.id, body: c.body, user: c.user, updated_at: c.updated_at,
      issue_url: `https://api.github.com${R}/issues/${c.number}`,
      html_url: `https://github.com/o/r/${kind}/${c.number}#issuecomment-${c.id}`,
    };
  }

  private issueJson(i: MemIssue) {
    return {
      id: i.id, number: i.number, title: i.title, body: i.body, user: i.user, state: i.state, state_reason: i.state_reason,
      closed_by: i.closed_by, updated_at: i.updated_at, labels: i.labels.map((name) => ({ name })),
      ...(i.pull ? { pull_request: { merged_at: i.pull.merged_at } } : {}),
    };
  }

  private pullJson(i: MemIssue) {
    const p = i.pull!;
    return {
      number: i.number, state: i.state, title: i.title, body: i.body, user: i.user, updated_at: i.updated_at, draft: p.draft,
      head: { ...p.head, repo: { full_name: "o/r" } }, base: p.base, labels: i.labels.map((name) => ({ name })),
      merged: p.merged_at !== null, merged_at: p.merged_at, merge_commit_sha: p.merge_commit_sha, merged_by: p.merged_by,
      mergeable: true, html_url: `https://github.com/o/r/pull/${i.number}`,
    };
  }

  override async text(path: string): Promise<string> {
    throw new GitHubError(404, `GitHub GET ${path} → 404`);
  }

  override async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.route(method, path, (body ?? {}) as Record<string, unknown>) as T;
  }

  private route(method: string, path: string, b: Record<string, unknown>): unknown {
    const [bare, qs = ""] = path.split("?") as [string, string?];
    const q = new URLSearchParams(qs);
    // Every list here fits one page: later pages are empty.
    const page = (xs: unknown[]) => (Number(q.get("page") ?? "1") > 1 ? [] : xs);
    const all = [...this.issues.values()];
    let m: RegExpExecArray | null;

    if (bare === `${R}/labels` && method === "POST") return {};
    if (bare === `${R}/issues` && method === "GET") {
      const label = q.get("labels");
      const state = q.get("state") ?? "open";
      const since = q.get("since");
      const xs = all
        .filter((i) => (state === "all" || i.state === state) && (!label || i.labels.includes(label)) && (!since || i.updated_at >= since))
        .sort((a, b) => (q.get("sort") === "created" ? b.number - a.number : a.updated_at.localeCompare(b.updated_at)));
      return page(xs.map((i) => this.issueJson(i)));
    }
    if (bare === `${R}/issues` && method === "POST") {
      const i = this.addIssue({ title: String(b.title), body: String(b.body ?? ""), labels: (b.labels as string[]) ?? [], user: BOT });
      return this.issueJson(i);
    }
    if (bare === `${R}/issues/comments` && method === "GET") {
      const since = q.get("since");
      const xs = this.comments.filter((c) => !since || c.updated_at >= since).sort((a, b) => a.updated_at.localeCompare(b.updated_at));
      return page(xs.map((c) => this.commentJson(c)));
    }
    if ((m = /^\/repos\/o\/r\/issues\/comments\/(\d+)\/reactions$/.exec(bare))) {
      const c = this.comments.find((x) => x.id === Number(m![1]));
      if (!c) throw new GitHubError(404, "no comment");
      if (method === "GET") return page([]);
      if (!c.reactions.includes(String(b.content))) c.reactions.push(String(b.content));
      return {};
    }
    if ((m = /^\/repos\/o\/r\/issues\/(\d+)$/.exec(bare))) {
      const i = this.issue(Number(m[1]));
      if (method === "GET") return this.issueJson(i);
      if (method === "PATCH") {
        if (b.state === "closed") {
          if (i.state !== "closed") i.closed_by = BOT;
          i.state = "closed";
          i.state_reason = String(b.state_reason ?? "completed");
        }
        i.updated_at = this.tick();
        return this.issueJson(i);
      }
    }
    if ((m = /^\/repos\/o\/r\/issues\/(\d+)\/comments$/.exec(bare))) {
      const n = Number(m[1]);
      this.issue(n);
      if (method === "GET") return page(this.comments.filter((c) => c.number === n).map((c) => this.commentJson(c)));
      return this.commentJson(this.addComment(n, String(b.body), BOT));
    }
    if ((m = /^\/repos\/o\/r\/issues\/(\d+)\/labels$/.exec(bare))) {
      const i = this.issue(Number(m[1]));
      if (method === "GET") return page(i.labels.map((name) => ({ name })));
      for (const l of b.labels as string[]) {
        if (!i.labels.includes(l)) i.labels.push(l);
        i.timeline.push({ event: "labeled", label: { name: l }, actor: BOT });
      }
      return i.labels.map((name) => ({ name }));
    }
    if ((m = /^\/repos\/o\/r\/issues\/(\d+)\/labels\/(.+)$/.exec(bare)) && method === "DELETE") {
      const i = this.issue(Number(m[1]));
      const name = decodeURIComponent(m[2]!);
      if (!i.labels.includes(name)) throw new GitHubError(404, "label not on issue");
      i.labels = i.labels.filter((l) => l !== name);
      return undefined;
    }
    if ((m = /^\/repos\/o\/r\/issues\/(\d+)\/reactions$/.exec(bare)) && method === "POST") {
      const i = this.issue(Number(m[1]));
      if (!i.reactions.includes(String(b.content))) i.reactions.push(String(b.content));
      return {};
    }
    if ((m = /^\/repos\/o\/r\/issues\/(\d+)\/timeline$/.exec(bare))) return page(this.issue(Number(m[1])).timeline);
    if ((m = /^\/repos\/o\/r\/issues\/(\d+)\/sub_issues$/.exec(bare))) {
      const i = this.issue(Number(m[1]));
      if (method === "GET") return page(i.sub_issues.map((n) => this.issueJson(this.issue(n))));
      const sub = all.find((x) => x.id === b.sub_issue_id);
      if (!sub) throw new GitHubError(404, "no such issue");
      if (i.sub_issues.includes(sub.number)) throw new GitHubError(422, "already a sub-issue");
      i.sub_issues.push(sub.number);
      return {};
    }
    if ((m = /^\/repos\/o\/r\/issues\/(\d+)\/dependencies\/blocked_by$/.exec(bare))) return page([]);

    if (bare === `${R}/pulls` && method === "GET") {
      const head = q.get("head");
      const pulls = all.filter((i) => i.pull && i.state === (q.get("state") ?? "open"));
      if (head !== null) return pulls.filter((i) => `o:${i.pull!.head.ref}` === head).map((i) => this.pullJson(i));
      return page(pulls.sort((a, b) => b.updated_at.localeCompare(a.updated_at)).map((i) => this.pullJson(i)));
    }
    if (bare === `${R}/pulls` && method === "POST") {
      const i = this.addPull(++this.n, { ref: String(b.head), sha: "c".repeat(40) }, String(b.base));
      i.title = String(b.title);
      i.body = String(b.body);
      return this.pullJson(i);
    }
    if ((m = /^\/repos\/o\/r\/pulls\/(\d+)$/.exec(bare))) {
      const i = this.issue(Number(m[1]));
      if (!i.pull) throw new GitHubError(404, "not a PR");
      if (method === "PATCH") {
        if (b.state === "closed") i.state = "closed";
        if (typeof b.title === "string") i.title = b.title;
        if (typeof b.body === "string") i.body = b.body;
        i.updated_at = this.tick();
      }
      return this.pullJson(i);
    }
    if ((m = /^\/repos\/o\/r\/pulls\/(\d+)\/merge$/.exec(bare)) && method === "PUT") {
      const i = this.issue(Number(m[1]));
      const p = i.pull!;
      if (i.state !== "open") throw new GitHubError(405, "Pull Request is not mergeable");
      if (b.sha !== p.head.sha) throw new GitHubError(409, "Head branch was modified");
      p.merged_at = i.updated_at = this.tick();
      p.merge_commit_sha = `${String(i.number).padStart(4, "0")}`.padEnd(40, "e");
      p.merged_by = BOT;
      i.state = "closed";
      return { sha: p.merge_commit_sha, merged: true };
    }
    if ((m = /^\/repos\/o\/r\/pulls\/(\d+)\/reviews$/.exec(bare))) return page(this.issue(Number(m[1])).pull!.reviews);
    if ((m = /^\/repos\/o\/r\/pulls\/\d+\/reviews\/\d+\/comments$/.exec(bare))) return page([]);
    if ((m = /^\/repos\/o\/r\/pulls\/\d+\/files$/.exec(bare))) return page([]);

    if ((m = /^\/repos\/o\/r\/commits\/([^/]+)\/check-runs$/.exec(bare))) {
      const runs = this.checkRuns.get(decodeURIComponent(m[1]!)) ?? [];
      return { total_count: runs.length, check_runs: Number(q.get("page") ?? "1") > 1 ? [] : runs };
    }
    if ((m = /^\/repos\/o\/r\/commits\/([^/]+)\/status$/.exec(bare))) return { statuses: this.statuses.get(decodeURIComponent(m[1]!)) ?? [] };
    if ((m = /^\/repos\/o\/r\/commits\/([^/]+)$/.exec(bare))) {
      const sha = decodeURIComponent(m[1]!);
      if (!this.commits.has(sha)) throw new GitHubError(404, "No commit found");
      return { sha, author: this.commits.get(sha) };
    }
    if (bare === `${R}/commits` && method === "GET") return page([]);
    if ((m = /^\/repos\/o\/r\/compare\/(.+)$/.exec(bare))) {
      const range = decodeURIComponent(m[1]!);
      if (!this.compare.has(range)) throw new GitHubError(404, "Not Found");
      return { ahead_by: this.compare.get(range) };
    }
    throw new Error(`MemoryGitHub: unexpected ${method} ${path}`);
  }
}
