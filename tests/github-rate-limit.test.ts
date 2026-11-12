import { describe, expect, it } from "vitest";
import {
  GITHUB_RATE_LIMIT, GITHUB_RATE_LIMITED, failureClass, githubRateLimitMessage, githubRateLimitReset, retryNotBefore,
} from "../src/core/policy.js";
import type { Run, RunOutcome, Timestamp, WorkItemId, WorkerId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { GitHubToolBroker } from "../src/impl/github/github-tool-broker.js";
import { GitHubForge } from "../src/impl/github/github-forge.js";
import { GitHubClient, GitHubError, GitHubRateLimitError } from "../src/impl/github/github-client.js";
import { OpaqueSecret } from "../src/impl/secrets/env-file-secret-store.js";
import type { GitHubCredentials } from "../src/interfaces/github-credentials.js";
import { secretName } from "../src/interfaces/secret-store.js";
import type { ToolResult } from "../src/interfaces/tool-broker.js";
import { cleanScanner, pipeline } from "./helpers/fakes.js";
import { issue, newStore, system, w1 } from "./helpers/store.js";

// Design §5 Restarts: a GitHub rate limit (a 403 or 429 that says so, or the client's own refusal with no calls
// left) is `github_rate_limited` with the reset time, never `forge_auth`. It sets the `github_rate_limit` claim
// pause, which holds implement, update and review claims until the reset; it spends no attempt.

const credentials: GitHubCredentials = { token: async () => new OpaqueSecret(secretName("GITHUB_TOKEN"), "ghs_test") };
const iso = (ms: number) => new Date(ms).toISOString();
type Failed = Extract<RunOutcome, { status: "failed" }>;

/** One scripted answer of the fake GitHub. */
interface Answer {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}

/** A client over a fetch that gives `answer(method, path)`, or 200 `{}`; every call is recorded. */
function clientWith(clock: FakeClock, answer: (method: string, path: string) => Answer | null) {
  const calls: string[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.pathname}${url.search}`);
    const a = answer(method, url.pathname + url.search) ?? { status: 200, body: "{}" };
    return new Response(a.body ?? "{}", { status: a.status, headers: { "content-type": "application/json", ...a.headers } });
  }) as typeof fetch;
  return { client: new GitHubClient(credentials, "https://gh.test", { fetch: fetchFn, clock, etag_entries: 0 }), calls };
}

const PRIMARY_BODY = JSON.stringify({ message: "API rate limit exceeded for installation ID 1.", documentation_url: "https://docs.github.com" });
const SECONDARY_BODY = JSON.stringify({ message: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again." });

/** A primary-limit 403 whose reset is `resetSec` (epoch seconds). */
const primary = (resetSec: number): Answer => ({
  status: 403,
  body: PRIMARY_BODY,
  headers: { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetSec), "x-ratelimit-resource": "core" },
});

async function thrown(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected a throw");
}

describe("REST client: rate limits", () => {
  it("a 403 that says the API rate limit was exceeded, with remaining 0 and a reset, is a rate-limit error with that reset", async () => {
    const clock = new FakeClock();
    const reset = Math.floor(clock.now().getTime() / 1000) + 600;
    const { client } = clientWith(clock, () => primary(reset));
    const err = await thrown(client.request("GET", "/repos/o/r"));
    expect(err).toBeInstanceOf(GitHubRateLimitError);
    expect((err as GitHubRateLimitError).reset_at).toBe(iso(reset * 1000));
    expect((err as GitHubRateLimitError).status).toBe(403);
  });

  it("a call refused locally with no calls left before the reset is the same rate-limit error, and is not sent", async () => {
    const clock = new FakeClock();
    const reset = Math.floor(clock.now().getTime() / 1000) + 600;
    const { client, calls } = clientWith(clock, () => primary(reset));
    await thrown(client.request("GET", "/repos/o/r"));
    const err = await thrown(client.request("GET", "/repos/o/r/pulls"));
    expect(err).toBeInstanceOf(GitHubRateLimitError);
    expect((err as GitHubRateLimitError).reset_at).toBe(iso(reset * 1000));
    expect(calls).toEqual(["GET /repos/o/r"]);
  });

  it("a 429, or a 403 with retry-after, gives the reset from retry-after", async () => {
    for (const status of [429, 403]) {
      const clock = new FakeClock();
      const { client } = clientWith(clock, () => ({ status, body: SECONDARY_BODY, headers: { "retry-after": "120" } }));
      const err = await thrown(client.request("POST", "/repos/o/r/issues/1/comments", { body: "x" }));
      expect(err).toBeInstanceOf(GitHubRateLimitError);
      expect((err as GitHubRateLimitError).reset_at).toBe(iso(clock.now().getTime() + 120_000));
    }
  });

  it("a 403 whose body names the secondary limit, with no header, is a rate limit too", async () => {
    const clock = new FakeClock();
    const { client } = clientWith(clock, () => ({ status: 403, body: SECONDARY_BODY }));
    const err = await thrown(client.request("GET", "/repos/o/r"));
    expect(err).toBeInstanceOf(GitHubRateLimitError);
    expect(Date.parse((err as GitHubRateLimitError).reset_at)).toBeGreaterThan(clock.now().getTime());
  });

  it("a plain 403 with calls left is still a GitHubError, not a rate limit", async () => {
    const clock = new FakeClock();
    const reset = Math.floor(clock.now().getTime() / 1000) + 600;
    const { client } = clientWith(clock, () => ({
      status: 403,
      body: JSON.stringify({ message: "Resource not accessible by integration" }),
      headers: { "x-ratelimit-remaining": "4000", "x-ratelimit-reset": String(reset) },
    }));
    const err = await thrown(client.request("GET", "/repos/o/r"));
    expect(err).toBeInstanceOf(GitHubError);
    expect(err).not.toBeInstanceOf(GitHubRateLimitError);
    expect((err as GitHubError).status).toBe(403);
  });
});

describe("broker and forge: github_rate_limited", () => {
  async function brokerWith(answer: (method: string, path: string) => Answer | null) {
    const { store, clock } = await newStore();
    const { item } = await store.createWorkItem(issue(1), system, { enqueue: { kind: "implement", idempotency_key: "k" } });
    const run = (await store.claimRun({ worker_id: "w" as WorkerId, kinds: ["implement"], lease_ms: 60_000 }))!;
    const fake = new FakeClock(clock.now());
    const { client } = clientWith(fake, answer);
    const broker = new GitHubToolBroker({
      client, store, scanner: cleanScanner, clock: fake, repo: { owner: "o", name: "r" }, branchPrefix: "factory/",
    });
    const forge = new GitHubForge(client, { owner: "o", name: "r" }, "factory/", "main", {} as never);
    const ctx = { run_id: run.id, work_item_id: item.id as WorkItemId, lease_token: run.lease!.token };
    const branch = `factory/${item.id}`;
    const calls = {
      preflight: () => broker.call(ctx, "forge.preflight", { branch, base_ref: "main" }),
      // The PR write is the forge's (outbound's github-change, RFC 0015 M7): its error starts with its class.
      open_pr: () => forge.openPr({ branch, base_ref: "main", title: "t", body: "b" }).then(
        (): ToolResult => ({ ok: true, content: {} }),
        (e: Error): ToolResult => {
          const [code, ...rest] = e.message.split(": ");
          return { ok: false, error_code: code!, message: rest.join(": ") };
        },
      ),
    };
    return { calls, now: fake.now().getTime() };
  }

  it("a rate-limit 403 gives github_rate_limited with the header's reset on preflight and open_pr", async () => {
    for (const tool of ["preflight", "open_pr"] as const) {
      let reset = 0;
      const b = await brokerWith(() => primary(reset));
      reset = Math.floor(b.now / 1000) + 900;
      const r = await b.calls[tool]();
      expect(r).toMatchObject({ ok: false, error_code: GITHUB_RATE_LIMITED });
      expect(githubRateLimitReset((r as Extract<ToolResult, { ok: false }>).message)).toBe(iso(reset * 1000));
    }
  });

  it("a 429 or a 403 with retry-after gives github_rate_limited with the retry-after reset", async () => {
    for (const status of [429, 403]) {
      for (const tool of ["preflight", "open_pr"] as const) {
        const b = await brokerWith(() => ({ status, body: SECONDARY_BODY, headers: { "retry-after": "60" } }));
        const r = await b.calls[tool]();
        expect(r).toMatchObject({ ok: false, error_code: GITHUB_RATE_LIMITED });
        expect(githubRateLimitReset((r as Extract<ToolResult, { ok: false }>).message)).toBe(iso(b.now + 60_000));
      }
    }
  });

  it("a 401 still gives forge_auth from preflight and open_pr", async () => {
    for (const tool of ["preflight", "open_pr"] as const) {
      const b = await brokerWith(() => ({ status: 401, body: JSON.stringify({ message: "Bad credentials" }) }));
      expect(await b.calls[tool]()).toMatchObject({ ok: false, error_code: "forge_auth" });
    }
  });

  it("a plain 403 with no rate-limit signal still gives forge_auth", async () => {
    for (const tool of ["preflight", "open_pr"] as const) {
      const b = await brokerWith(() => ({ status: 403, body: JSON.stringify({ message: "Resource not accessible by integration" }) }));
      expect(await b.calls[tool]()).toMatchObject({ ok: false, error_code: "forge_auth" });
    }
  });
});

describe("policy: a GitHub rate limit is not an attempt", () => {
  const failed = (error_code: string): Failed => ({ status: "failed", error_code, detail: "", infra: false });

  it("is classed with rate limits, so it spends no attempt and no restart", () => {
    expect(failureClass(failed(GITHUB_RATE_LIMITED))).toBe("rate_limited");
  });

  it("the message carries the reset and reads back", () => {
    expect(githubRateLimitReset(githubRateLimitMessage("open_pr", "2026-11-07T10:00:00.000Z"))).toBe("2026-11-07T10:00:00.000Z");
    expect(githubRateLimitReset("open_pr: something else")).toBeNull();
  });

  it("its retry waits for the later of its backoff and the pause end", () => {
    const at = Date.parse("2026-11-07T10:00:00.000Z");
    const later = iso(at + 10 * 60_000) as Timestamp;
    const sooner = iso(at + 1_000) as Timestamp;
    const r = (reset: Timestamp | null) =>
      retryNotBefore({ cls: "rate_limited", code: GITHUB_RATE_LIMITED, failed_at: at, backoff_at: at + 30_000, reset, retry_max_ms: 3_600_000 });
    expect(r(later)).toBe(later);
    expect(r(sooner)).toBe(iso(at + 30_000));
    // The model rate limit still waits for its reset alone.
    expect(retryNotBefore({ cls: "rate_limited", code: "rate_limited", failed_at: at, backoff_at: at + 30_000, reset: sooner, retry_max_ms: 1 })).toBe(sooner);
  });
});

describe("worker and controller: the github_rate_limit pause", () => {
  const LIMITED = (reset: string): ToolResult => ({ ok: false, error_code: GITHUB_RATE_LIMITED, message: githubRateLimitMessage("pr_api", reset) });

  it("a preflight rate limit sets the github_rate_limit pause to the reset, and no other pause", async () => {
    const f = await pipeline();
    const reset = iso(f.clock.now().getTime() + 20 * 60_000);
    f.broker.responses["forge.preflight"] = [LIMITED(reset)];
    const a = await f.submit();
    await f.step();
    expect(await f.store.getClaimPause(GITHUB_RATE_LIMIT)).toBe(reset);
    expect(await f.store.getClaimPause()).toBeNull();
    expect(await f.store.getClaimPause("forge_auth")).toBeNull();
    const [failedRun, retry] = await f.runs(a, "implement");
    expect(failedRun!.outcome).toMatchObject({ status: "failed", error_code: GITHUB_RATE_LIMITED, reset_at: reset });
    // No attempt and no restart: the retry is queued for the pause end, the item does not block.
    expect(retry).toMatchObject({ status: "queued", not_before: reset });
    expect(await f.item(a)).toMatchObject({ stage: "RUNNING", blocked_on: "none", restart_count: 0 });
    expect(f.agentCalls("implement")).toBe(0);
  });

  it("the controller skips its GitHub poll while the pause holds and logs nothing for it", async () => {
    const f = await pipeline();
    await f.controller.tickIntake();
    const polls = f.source.polls.length;
    const lines = f.log.lines.length;
    await f.store.pauseClaims(iso(f.clock.now().getTime() + 60_000) as Timestamp, GITHUB_RATE_LIMIT);
    await f.controller.tickIntake();
    await f.controller.tickIntake();
    expect(f.source.polls.length).toBe(polls);
    expect(f.log.lines.length).toBe(lines);
    f.clock.advance(60_000);
    await f.controller.tickIntake();
    expect(f.source.polls.length).toBe(polls + 1);
  });
});

describe("store: claimRun honours github_rate_limit (SQLite)", () => {
  it("skips implement, update and review runs and still claims triage and resolve runs", async () => {
    const { store, clock } = await newStore();
    const kinds = ["implement", "update", "review", "triage", "resolve"] as const;
    const items = new Map<string, string>();
    for (const [i, kind] of kinds.entries()) {
      const { item } = await store.createWorkItem(issue(10 + i), system, { enqueue: { kind, idempotency_key: kind } });
      items.set(item.id, kind);
    }
    await store.pauseClaims(iso(clock.now().getTime() + 60_000) as Timestamp, GITHUB_RATE_LIMIT);
    const claimed: string[] = [];
    let r: Run | null;
    while ((r = await store.claimRun({ worker_id: w1, kinds: [...kinds], lease_ms: 60_000 }))) claimed.push(r.kind);
    expect(claimed.sort()).toEqual(["resolve", "triage"]);
    clock.advance(60_000);
    while ((r = await store.claimRun({ worker_id: w1, kinds: [...kinds], lease_ms: 60_000 }))) claimed.push(r.kind);
    expect(claimed.sort()).toEqual([...kinds].sort());
  });
});
