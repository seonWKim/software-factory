import type { GitHubBudgetStatus } from "../../core/controller.js";
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
    /** Set on a call refused locally with no calls left: the reset time (ISO) the caller waits for. */
    readonly wait_until: string | null = null,
  ) {
    super(message);
  }
}

/** Default `github.min_remaining`: below this many core calls left in the hour, optional reads wait for the reset. */
export const DEFAULT_MIN_REMAINING = 200;
/** Default `github.budget_share`: this factory may use the whole hourly core limit (solo: one App, one factory). */
export const DEFAULT_BUDGET_SHARE = 1;
/** Default ETag cache size per client (one per process): entries, each one GET's URL, ETag and body. */
export const DEFAULT_ETAG_ENTRIES = 500;
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
  /** `github.budget_share` (docs/plugins/github-credentials.md): this process's part of the hourly core limit. Absent: 1. */
  budget_share?: number;
}

/** This process's counted calls in one rate-limit window, the window named by its reset time. */
interface Window {
  reset_at: string;
  counted: number;
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
 * `github.budget_share` from factory.config.json: absent means DEFAULT_BUDGET_SHARE, else a number greater than 0
 * and at most 1 (the part of the installation's hourly core limit this factory may use).
 */
export function githubBudgetShare(github: { budget_share?: unknown } | undefined): number {
  const v = github?.budget_share;
  if (v === undefined) return DEFAULT_BUDGET_SHARE;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 1) {
    throw new Error(`github.budget_share must be a number greater than 0 and at most 1, got ${JSON.stringify(v) ?? String(v)}`);
  }
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
 * refused here with the 403 GitHub would answer, without sending it, carrying the reset as `wait_until`; under
 * `min_remaining`, or once this process has made its `budget_share` of the window's limit in counted calls (every
 * answer but a 304), `lowBudget()` is true and callers skip the reads that can wait. The count is per process
 * (in memory, like the ETag cache): replicas of one factory on one App split its share between them.
 *
 * Catch-up reads (a first start's backlog) take a per-minute allowance, `takeCatchUp`: at most
 * (budget_share × limit) / 60 a minute, so a new start spreads them over several polls.
 */
export class GitHubClient {
  private readonly cache = new Map<string, Cached>();
  private readonly fetchFn: typeof fetch;
  private readonly maxEntries: number;
  private readonly minRemaining: number;
  private readonly share: number;
  private rate: RateBudget | null = null;
  private window: Window | null = null;
  /** Catch-up reads taken in the current clock minute (`minute`, ms since the epoch / 60 000). */
  private catchUp = { minute: -1, taken: 0 };
  private low = false;

  constructor(
    private readonly credentials: GitHubCredentials,
    private readonly baseUrl = "https://api.github.com",
    private readonly opts: GitHubClientOptions = {},
  ) {
    this.fetchFn = opts.fetch ?? ((...a) => fetch(...a));
    this.maxEntries = opts.etag_entries ?? DEFAULT_ETAG_ENTRIES;
    this.minRemaining = opts.min_remaining ?? DEFAULT_MIN_REMAINING;
    this.share = opts.budget_share ?? DEFAULT_BUDGET_SHARE;
  }

  /** The core rate limit as of the last response; null before any response carried the headers. */
  budget(): RateBudget | null {
    return this.rate ? { ...this.rate } : null;
  }

  /** This process's counted calls in the current window; 0 once its reset has passed. */
  counted(): number {
    const w = this.window;
    return w === null || this.now() >= Date.parse(w.reset_at) ? 0 : w.counted;
  }

  /** The calls this process may count in a window: `budget_share` × the limit, rounded down; null before any limit is known. */
  private shareLimit(): number | null {
    return this.rate && this.rate.limit > 0 ? Math.floor(this.share * this.rate.limit) : null;
  }

  /** The budget as the status page shows it (design §9): GitHub's numbers, this process's share and count, the state. */
  status(): GitHubBudgetStatus | null {
    const r = this.rate;
    if (!r) return null;
    const before = this.now() < Date.parse(r.reset_at);
    const state = before && r.remaining <= 0 ? "waiting" : this.lowBudget() ? "low" : "ok";
    return {
      limit: r.limit, remaining: r.remaining, reset_at: r.reset_at, budget_share: this.share, share_limit: this.shareLimit(),
      counted: this.counted(), state, as_of: new Date(this.now()).toISOString(),
    };
  }

  /**
   * True while the reset has not passed and fewer than `min_remaining` core calls are left, or this process has
   * made its `budget_share` of the limit: skip optional reads (refreshes that a later poll makes as well). Logs
   * one line on entering and one on leaving.
   */
  lowBudget(): boolean {
    const r = this.rate;
    const before = r !== null && this.now() < Date.parse(r.reset_at);
    const floor = before && r!.remaining < this.minRemaining;
    const cap = this.shareLimit();
    const shared = before && cap !== null && this.counted() >= cap;
    const low = floor || shared;
    if (low !== this.low) {
      this.low = low;
      if (low) {
        this.opts.log?.warn("GitHub budget low: optional reads wait for the reset", {
          remaining: r!.remaining, min_remaining: this.minRemaining, reset_at: r!.reset_at,
          ...(!floor && { counted: this.counted(), budget_share: this.share }),
        });
      } else this.opts.log?.info("GitHub budget back: optional reads resume", { remaining: r?.remaining ?? null });
    }
    return low;
  }

  /**
   * Takes up to `n` catch-up reads from this minute's allowance, (budget_share × limit) / 60 rounded down, at
   * least 1; returns how many it took (0: wait for the next minute). None while `lowBudget()`. Before any limit
   * is known, every one is granted.
   */
  takeCatchUp(n: number): number {
    if (this.lowBudget()) return 0;
    const cap = this.shareLimit();
    if (cap === null) return n;
    const minute = Math.floor(this.now() / 60_000);
    if (minute !== this.catchUp.minute) this.catchUp = { minute, taken: 0 };
    const granted = Math.max(0, Math.min(n, Math.max(1, Math.floor(cap / 60)) - this.catchUp.taken));
    this.catchUp.taken += granted;
    return granted;
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
      throw new GitHubError(403, `GitHub ${method} ${path} → 403 API rate limit exceeded (not sent: no calls left until ${r.reset_at})`, r.reset_at);
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
    if (res.status !== 304) this.count();
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

  /** One counted call in the window of the last reported reset; a new reset time starts a new window at zero. */
  private count(): void {
    const reset = this.rate?.reset_at;
    if (reset === undefined) return;
    if (this.window?.reset_at !== reset) this.window = { reset_at: reset, counted: 0 };
    this.window.counted++;
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
