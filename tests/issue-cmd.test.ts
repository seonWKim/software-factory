import { describe, expect, it } from "vitest";
import type { EgressScanner } from "../src/interfaces/egress-scanner.js";
import type { GitHubCredentials } from "../src/interfaces/github-credentials.js";
import { GitHubClient } from "../src/impl/github/github-client.js";
import { parseIssueArgs, runIssue } from "../src/issue-cmd.js";

class FakeClient extends GitHubClient {
  calls: { method: string; path: string; body: unknown }[] = [];
  constructor() {
    super({} as GitHubCredentials, "http://unused");
  }
  override async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    this.calls.push({ method, path, body });
    if (method === "GET") return { id: 9001 } as T;
    return { number: 95, html_url: "https://github.com/o/r/issues/95" } as T;
  }
}
const clean: EgressScanner = { scan: async () => ({ clean: true, findings: [] }) } as unknown as EgressScanner;
const dirty: EgressScanner = { scan: async () => ({ clean: false, findings: [{ rule: "github_token" }] }) } as unknown as EgressScanner;
const repo = { owner: "o", name: "r" };
const read = async (p: string) => `body of ${p}`;

describe("factory issue", () => {
  it("parses each action and rejects incomplete or unknown ones", () => {
    expect(parseIssueArgs(["create", "--title", "T", "--body-file", "b.md", "--label", "factory", "--label", "x"]))
      .toEqual({ action: "create", title: "T", bodyFile: "b.md", labels: ["factory", "x"] });
    expect(parseIssueArgs(["comment", "12", "--body-file", "b.md"])).toEqual({ action: "comment", number: 12, bodyFile: "b.md" });
    expect(parseIssueArgs(["title", "12", "Short", "title"])).toEqual({ action: "title", number: 12, title: "Short title" });
    expect(parseIssueArgs(["sub-issue", "58", "88"])).toEqual({ action: "sub-issue", parent: 58, child: 88 });
    for (const bad of [[], ["close", "1"], ["create", "--title", "T"], ["create", "--body-file", "b"], ["comment", "x", "--body-file", "b"],
      ["comment", "1"], ["title", "1"], ["sub-issue", "1"], ["create", "--title", "T", "--body-file", "b", "--bogus", "v"]]) {
      expect(parseIssueArgs(bad)).toBeNull();
    }
  });

  it("sends each action to the right endpoint with the right body", async () => {
    const client = new FakeClient();
    const d = { client, repo, scanner: clean, read };
    expect(await runIssue(d, { action: "create", title: "T", bodyFile: "b.md", labels: ["factory"] })).toBe("#95 https://github.com/o/r/issues/95");
    await runIssue(d, { action: "comment", number: 12, bodyFile: "c.md" });
    await runIssue(d, { action: "title", number: 12, title: "New" });
    expect(await runIssue(d, { action: "sub-issue", parent: 58, child: 88 })).toBe("#88 is now a sub-issue of #58");
    expect(client.calls).toEqual([
      { method: "POST", path: "/repos/o/r/issues", body: { title: "T", body: "body of b.md", labels: ["factory"] } },
      { method: "POST", path: "/repos/o/r/issues/12/comments", body: { body: "body of c.md" } },
      { method: "PATCH", path: "/repos/o/r/issues/12", body: { title: "New" } },
      { method: "GET", path: "/repos/o/r/issues/88", body: undefined },
      { method: "POST", path: "/repos/o/r/issues/58/sub_issues", body: { sub_issue_id: 9001 } },
    ]);
  });

  it("refuses a title or body the leak scanner flags, and sends nothing", async () => {
    const client = new FakeClient();
    await expect(runIssue({ client, repo, scanner: dirty, read }, { action: "comment", number: 1, bodyFile: "c.md" })).rejects.toThrow("github_token");
    expect(client.calls).toEqual([]);
  });
});
