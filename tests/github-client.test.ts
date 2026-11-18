import { describe, expect, it } from "vitest";
import { GitHubClient, GitHubError } from "../src/impl/github/github-client.js";
import type { GitHubCredentials } from "../src/interfaces/github-credentials.js";
import type { Secret } from "../src/interfaces/secret-store.js";

const credentials: GitHubCredentials = { token: async () => ({ reveal: () => "tkn" }) as Secret };
const LOG = "2026-11-18T08:00:00Z  FAIL  tests/a.test.ts > b\nAssertionError: expected 1 to be 2\n";

/** A client over a fetch that answers `answers` in order, recording each call. */
function client(answers: Response[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = answers.shift();
    if (!next) throw new Error(`unexpected fetch ${url}`);
    return next;
  }) as unknown as typeof globalThis.fetch;
  return { calls, gh: new GitHubClient(credentials, "https://gh.test", { fetch }) };
}

const headers = (init: RequestInit) => init.headers as Record<string, string>;

describe("GitHubClient.text", () => {
  it("follows the job-logs redirect without the token and returns the plain-text body", async () => {
    const { calls, gh } = client([
      new Response(null, { status: 302, headers: { location: "https://logs.test/job/9?sig=x" } }),
      new Response(LOG, { status: 200, headers: { "content-type": "text/plain" } }),
    ]);
    expect(await gh.text("/repos/o/r/actions/jobs/9/logs")).toBe(LOG);
    expect(calls.map((c) => c.url)).toEqual(["https://gh.test/repos/o/r/actions/jobs/9/logs", "https://logs.test/job/9?sig=x"]);
    expect(calls[0]!.init.redirect).toBe("manual");
    expect(headers(calls[0]!.init).Authorization).toBe("Bearer tkn");
    expect(headers(calls[1]!.init).Authorization).toBeUndefined();
  });

  it("returns a body GitHub sends directly, which need not be JSON", async () => {
    const { gh } = client([new Response("not { json", { status: 200 })]);
    expect(await gh.text("/repos/o/r/actions/jobs/9/logs")).toBe("not { json");
  });

  it("throws on a refused read (e.g. a token without the Actions read permission) and on a failed redirect", async () => {
    const refused = client([new Response("Resource not accessible by integration", { status: 403 })]);
    await expect(refused.gh.text("/repos/o/r/actions/jobs/9/logs")).rejects.toBeInstanceOf(GitHubError);
    const gone = client([
      new Response(null, { status: 302, headers: { location: "https://logs.test/job/9" } }),
      new Response("expired", { status: 410 }),
    ]);
    await expect(gone.gh.text("/repos/o/r/actions/jobs/9/logs")).rejects.toThrow(/410/);
  });
});

describe("GitHubClient.request", () => {
  it("a write answered with an empty body (a rerun's 201) returns undefined; a JSON body is parsed", async () => {
    const { gh } = client([new Response("", { status: 201 }), new Response('{"id":1}', { status: 201 })]);
    expect(await gh.request("POST", "/repos/o/r/actions/runs/7/rerun-failed-jobs")).toBeUndefined();
    expect(await gh.request("POST", "/repos/o/r/x")).toEqual({ id: 1 });
  });
});
