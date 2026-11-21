import { FakeClock } from "../../src/impl/clock/fake-clock.js";
import { GitHubClient } from "../../src/impl/github/github-client.js";
import type { PollContext } from "../../src/impl/github/github-issue-source.js";
import type { GitHubCredentials } from "../../src/interfaces/github-credentials.js";
import { silent } from "./fakes/config.js";

/** Records every request; GET answers come from `responses` by path prefix (without query), else []; text GETs from `texts`. */
export class RecordingGitHubClient extends GitHubClient {
  calls: { method: string; path: string; body: unknown }[] = [];
  responses: Record<string, unknown[]> = {};

  constructor() {
    super({} as GitHubCredentials, "http://unused");
  }
  override async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    this.calls.push({ method, path, body });
    if (method !== "GET") return {} as T;
    const bare = path.split("?")[0]!;
    // Pages after the first are always empty.
    if (!path.includes("page=1")) return [] as T;
    return (this.responses[bare] ?? []) as T;
  }
  /** Plain-text GET answers by path (e.g. a job's log); a path not listed throws as a refused read would. */
  texts: Record<string, string> = {};
  override async text(path: string): Promise<string> {
    this.calls.push({ method: "GET", path, body: undefined });
    const t = this.texts[path];
    if (t === undefined) throw new Error(`no text for ${path}`);
    return t;
  }
}

/** A first start on 2026-01-01, before every fixture here: merges in the fixtures are after the starting point. */
export function pollContext(o: Partial<PollContext> = {}): PollContext {
  return { clock: new FakeClock("2026-01-01T00:00:00Z"), history_since: null, log: silent, ...o };
}
