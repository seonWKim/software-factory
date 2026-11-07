import type { Logger } from "../../core/log.js";
import type { Clock } from "../../interfaces/clock.js";
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

/** Default `github.min_remaining`: below this many core calls left in the hour, optional reads wait for the reset. */
export const DEFAULT_MIN_REMAINING = 200;
/** Default ETag cache size per client (one per process): entries, each one GET's URL, ETag and body. */
export const DEFAULT_ETAG_ENTRIES = 500;
/** Below this share of the hourly limit left, optional reads wait for the reset too (issue #254). */
export const LOW_BUDGET_SHARE = 0.1;
/** A body larger than this is never cached (keeps the per-process cache bounded in bytes too). */
const MAX_CACHED_BODY = 1_000_000;

/** The core REST rate limit as GitHub's last response reported it (`x-ratelimit-*` headers). */
export interface RateBudget {
  limit: number;
  remaining: number;
  /** When the hourly window resets, ISO time. */
  reset_at: string;
}

export interface GitHubClientOptions {
  /** Tests inject a fake; absent: the global fetch. */
  fetch?: typeof fetch;
  /** For the reset time comparisons; absent: the system time. */
  clock?: Clock;
  /** One line when the budget drops under min_remaining, one when it is back. */
  log?: Logger;
  /** `github.min_remaining` (docs/plugins/github-credentials.md). Absent: DEFAULT_MIN_REMAINING. */
  min_remaining?: number;
  /** ETag cache entries; 0 turns conditional requests off. Absent: DEFAULT_ETAG_ENTRIES. */
  etag_entries?: number;
}

interface Cached {
  etag: string;
  body: string;
  headers: [string, string][];
}

/** `github.min_remaining` from factory.config.json: absent means DEFAULT_MIN_REMAINING, else a whole number >= 0. */
export function githubMinRemaining(github: { min_remaining?: unknown } | undefined): number {
  const v = github?.min_remaining;
  if (v === undefined) return DEFAULT_MIN_REMAINING;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new Error("github.min_remaining must be a whole number, 0 or more");
  return v;
}

/**
 * REST client. The token comes from GitHubCredentials at call time and never leaves this class.
 *
 * Every GET is conditional (design §5 Sources, GitHub call budget): the last ETag and body per URL are kept in a
 * bounded in-memory LRU, sent back as `If-None-Match`, and a 304 (which GitHub does not count against the rate
 * limit) answers with the kept body. The cache is only an optimization: GitHub decides on every call whether the
 * body is still current, and an empty cache (a new process, another replica) just makes full calls.
 *
 * Every response's `x-ratelimit-*` headers are kept (`budget()`). With none left before the reset, a call is
 * refused here with the 403 GitHub would answer, without sending it; under `min_remaining`, `lowBudget()` is
 * true and callers skip the reads that can wait.
 */
export class GitHubClient {
  private readonly cache = new Map<string, Cached>();
  private readonly fetchFn: typeof fetch;
  private readonly maxEntries: number;
  private readonly minRemaining: number;
  private rate: RateBudget | null = null;
  private low = false;

  constructor(
    private readonly credentials: GitHubCredentials,
    private readonly baseUrl = "https://api.github.com",
    private readonly opts: GitHubClientOptions = {},
  ) {
    this.fetchFn = opts.fetch ?? ((...a) => fetch(...a));
    this.maxEntries = opts.etag_entries ?? DEFAULT_ETAG_ENTRIES;
    this.minRemaining = opts.min_remaining ?? DEFAULT_MIN_REMAINING;
  }

  /** The core rate limit as of the last response; null before any response carried the headers. */
  budget(): RateBudget | null {
    return this.rate ? { ...this.rate } : null;
  }

  /**
   * True while fewer than `min_remaining` core calls, or under LOW_BUDGET_SHARE (10%) of the limit, are left and the
   * reset has not passed: skip optional reads (refreshes that a later poll makes as well). Logs one line on entering
   * and one on leaving.
   */
  lowBudget(): boolean {
    const r = this.rate;
    const floor = r === null ? 0 : Math.max(this.minRemaining, r.limit * LOW_BUDGET_SHARE);
    const low = r !== null && r.remaining < floor && this.now() < Date.parse(r.reset_at);
    if (low !== this.low) {
      this.low = low;
      if (low) this.opts.log?.warn("GitHub budget low: optional reads wait for the reset", { remaining: r!.remaining, min_remaining: this.minRemaining, reset_at: r!.reset_at });
      else this.opts.log?.info("GitHub budget back: optional reads resume", { remaining: r?.remaining ?? null });
    }
    return low;
  }

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
    const r = this.rate;
    if (r && r.remaining <= 0 && this.now() < Date.parse(r.reset_at)) {
      // GitHub would answer this 403 too; not sending it keeps a retry loop from hammering the API until the reset.
      throw new GitHubError(403, `GitHub ${method} ${path} → 403 API rate limit exceeded (not sent: no calls left until ${r.reset_at})`);
    }
    const token = await this.credentials.token();
    if (!token) throw new Error("GitHub credentials missing from the secret file (SET_UP.md, plugins.github_auth)");
    const key = `${accept} ${path}`;
    const cached = method === "GET" && this.maxEntries > 0 ? this.cache.get(key) : undefined;
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Accept: accept,
        Authorization: `Bearer ${token.reveal()}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "software-factory",
        ...(cached && { "If-None-Match": cached.etag }),
        ...(body !== undefined && { "Content-Type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    this.readRate(res.headers);
    if (res.status === 304 && cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return new Response(cached.body, { status: 200, headers: cached.headers });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new GitHubError(res.status, `GitHub ${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
    }
    const etag = res.headers.get("etag");
    if (method === "GET" && this.maxEntries > 0 && etag && res.status === 200) {
      const text = await res.text();
      if (text.length <= MAX_CACHED_BODY) {
        this.cache.delete(key);
        this.cache.set(key, { etag, body: text, headers: [...res.headers.entries()] });
        while (this.cache.size > this.maxEntries) this.cache.delete(this.cache.keys().next().value!);
      } else {
        this.cache.delete(key);
      }
      return new Response(text, { status: res.status, headers: res.headers });
    }
    return res;
  }

  /** Keeps the core limit from the response headers; another resource's limit (search, graphql) is ignored. */
  private readRate(h: Headers): void {
    const resource = h.get("x-ratelimit-resource");
    if (resource !== null && resource !== "core") return;
    const remaining = Number(h.get("x-ratelimit-remaining"));
    const limit = Number(h.get("x-ratelimit-limit"));
    const reset = Number(h.get("x-ratelimit-reset"));
    if (h.get("x-ratelimit-remaining") === null || !Number.isFinite(remaining) || !Number.isFinite(reset)) return;
    this.rate = { limit: Number.isFinite(limit) ? limit : 0, remaining, reset_at: new Date(reset * 1000).toISOString() };
  }

  private now(): number {
    return this.opts.clock ? this.opts.clock.now().getTime() : Date.now();
  }

  /** GETs up to `maxPages` pages of 100; stops early after a page for which `done` is true. */
  async list<T>(path: string, maxPages = 5, done?: (page: T[]) => boolean): Promise<T[]> {
    const out: T[] = [];
    const sep = path.includes("?") ? "&" : "?";
    for (let page = 1; page <= maxPages; page++) {
      const batch = await this.request<T[]>("GET", `${path}${sep}per_page=100&page=${page}`);
      out.push(...batch);
      if (batch.length < 100 || done?.(batch)) break;
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
