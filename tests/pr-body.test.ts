import { describe, expect, it } from "vitest";
import type { FactoryConfig } from "../src/core/config.js";
import { canAutoMerge } from "../src/core/policy.js";
import { lastPrNotes, prBody, splitSummary } from "../src/core/pr-body.js";
import type { Run, WorkItemId, WorkerId } from "../src/core/types.js";
import { GitHubToolBroker } from "../src/impl/broker/github-tool-broker.js";
import { GitHubError, type GitHubClient } from "../src/impl/github/github-client.js";
import type { GitHubCredentials } from "../src/interfaces/github-credentials.js";
import { cleanScanner, pipeline } from "./helpers/fakes.js";
import { issue, newStore, system } from "./helpers/store.js";

const SUMMARY = [
  "## In short (AS-IS → TO-BE)",
  "",
  "AS-IS: x. TO-BE: y.",
  "",
  "## What changed",
  "",
  "- a gate",
  "",
  "## Tests",
  "",
  "`npm test` passed (listen EPERM in the sandbox)",
  "",
  "### Sandbox notes",
  "",
  "more claims",
].join("\n");

const order = (body: string, ...parts: string[]) => parts.map((p) => body.indexOf(p));

describe("PR body layout (issue #229)", () => {
  it("In short → Before you merge → What changed → Tests, with the agent's own Tests section left out", () => {
    const body = prBody({
      summary: SUMMARY, missing: ["MySQL step: migrations/mysql/ is outside the allowed paths"], deviations: ["kept the old flag"],
      checks: ["Checked before push: `npm test` passed"], issue: "7", item_id: "wi_1", notes: ["A human merges this PR (tier 3)."],
    });
    const at = order(body, "## In short", "## Before you merge", "## What changed", "## Tests", "Closes #7");
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(body).toContain("- **Not done:** MySQL step: migrations/mysql/ is outside the allowed paths");
    expect(body).toContain("- **Differs from the spec:** kept the old flag");
    expect(body).toContain("- A human merges this PR (tier 3).");
    expect(body).not.toContain("listen EPERM");
    expect(body).not.toContain("more claims");
    expect(body.match(/## Tests/g)).toHaveLength(1);
    expect(body).toContain("Checked before push: `npm test` passed");
  });

  it("nothing to report says None; a summary with no headings goes under What changed", () => {
    const body = prBody({ summary: "plain text", missing: [], deviations: [], checks: [], issue: null, item_id: "wi_2" });
    expect(body).toContain("## Before you merge\n\nNone.");
    expect(body).toContain("## What changed\n\nplain text");
    expect(body).toContain("No pre-push checks ran.");
    expect(body).not.toContain("Closes");
  });

  it("splitSummary keeps In short's subsections with it", () => {
    const s = splitSummary("intro\n## In short\nA\n### detail\nB\n## Changes\nC");
    expect(s.in_short).toBe("## In short\nA\n### detail\nB");
    expect(s.rest).toBe("intro\n## Changes\nC");
  });

  it("lastPrNotes reads the newest succeeded implement run that stored notes", () => {
    const run = (kind: Run["kind"], data: Record<string, unknown>, status: "succeeded" | "failed" = "succeeded") =>
      ({ kind, outcome: status === "succeeded" ? { status, summary: "", data } : { status, error_code: "x", detail: "", infra: false } }) as Run;
    expect(lastPrNotes([run("implement", {})])).toBeNull();
    expect(lastPrNotes([
      run("implement", { pr_summary: "old", missing: ["a"] }),
      run("implement", { pr_summary: "new", missing: [], deviations: ["d"] }),
      run("implement", {}, "failed"),
      run("update", { pr_summary: "not an implement run" }),
    ])).toEqual({ summary: "new", missing: [], deviations: ["d"] });
  });

  it("an incomplete PR is never auto-merged, whatever the tier and dial", () => {
    // auto_merge_max_tier is fixed at 0 today; the cast tests the rule for when it may be raised.
    const dials = { spec_gate_min_tier: 3, auto_merge_max_tier: 5 } as unknown as FactoryConfig["dials"];
    expect(canAutoMerge(1, dials)).toBe(true);
    expect(canAutoMerge(1, dials, true)).toBe(false);
  });
});

describe("the worker keeps the PR body current (issue #229)", () => {
  const open = (f: Awaited<ReturnType<typeof pipeline>>) =>
    f.broker.calls.filter((c) => c.name === "github.open_pr").map((c) => c.args as { body: string; labels: Record<string, boolean> });

  it("missing work labels the PR incomplete and holds it back; the fix round rewrites the body and clears the label", async () => {
    let round = 0;
    const f = await pipeline({
      implement: () => {
        round++;
        return {
          output: round === 1
            ? { summary: "## In short\n\nfirst", next_steps: "n", missing: ["the MySQL step (path not allowed)"] }
            : { summary: "## In short\n\nsecond", next_steps: "n" },
        };
      },
    });
    let reviews = 0;
    f.runner.script.review = () => ({ output: { verdict: ++reviews === 1 ? "bug" : "pass", tier: 2, findings: ["fix it"], summary: "s" } });
    const it = await f.submit();
    await f.step();

    const bodies = open(f);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]!.body).toContain("- **Not done:** the MySQL step (path not allowed)");
    expect(bodies[0]!.labels).toEqual({ "sf: incomplete": true });
    expect(bodies[1]!.body).toContain("second");
    expect(bodies[1]!.body).not.toContain("Not done");
    expect(bodies[1]!.labels).toEqual({ "sf: incomplete": false });
    expect(await f.item(it)).toMatchObject({ blocked_reason: "merge_pending" });
    expect(f.source.comments.at(-1)!.body).toContain("human merge is required");
  });

  it("a PR that still reports missing work at merge time gets the incomplete comment, not the plain one", async () => {
    const f = await pipeline({
      implement: () => ({ output: { summary: "## In short\n\nx", next_steps: "n", missing: ["the MySQL step"] } }),
    });
    const it = await f.submit();
    await f.step();
    expect(await f.item(it)).toMatchObject({ blocked_reason: "merge_pending" });
    const last = f.source.comments.at(-1)!.body;
    expect(last).toContain("It is **incomplete**");
    expect(last).toContain("- the MySQL step");
    expect(last).not.toContain("A human merge is required.");
  });
});

describe("open_pr updates an open PR (issue #229)", () => {
  async function brokerWith(open: { number: number }[], fail404 = false) {
    const { store } = await newStore();
    const { item } = await store.createWorkItem(issue(1), system, { enqueue: { kind: "implement", idempotency_key: "k" } });
    const run = (await store.claimRun({ worker_id: "w" as WorkerId, kinds: ["implement"], lease_ms: 60_000 }))!;
    const calls: { method: string; path: string; body?: unknown }[] = [];
    const client = {
      request: async (method: string, path: string, body?: unknown) => {
        calls.push({ method, path, body });
        if (method === "GET") return open;
        if (method === "DELETE" && fail404) throw new GitHubError(404, "Label does not exist");
        return { number: open[0]?.number ?? 9, html_url: "u" };
      },
    } as unknown as GitHubClient;
    const broker = new GitHubToolBroker({
      client, credentials: { token: async () => null } as unknown as GitHubCredentials, store, scanner: cleanScanner,
      clock: { now: () => new Date() } as never, repo: { owner: "o", name: "r" }, branchPrefix: "factory/",
    });
    const ctx = { run_id: run.id, work_item_id: item.id as WorkItemId, lease_token: run.lease!.token };
    return { broker, ctx, calls, branch: `factory/${item.id}` };
  }

  it("an open PR gets the new title and body; labels are added and removed", async () => {
    const b = await brokerWith([{ number: 5 }]);
    const r = await b.broker.call(b.ctx, "github.open_pr", {
      branch: b.branch, base_ref: "main", title: "T", body: "B", labels: { "sf: incomplete": true, "sf: other": false },
    });
    expect(r).toMatchObject({ ok: true, content: { number: 5 } });
    expect(b.calls.slice(1)).toEqual([
      { method: "PATCH", path: "/repos/o/r/pulls/5", body: { title: "T", body: "B" } },
      { method: "POST", path: "/repos/o/r/issues/5/labels", body: { labels: ["sf: incomplete"] } },
      { method: "DELETE", path: "/repos/o/r/issues/5/labels/sf%3A%20other", body: undefined },
    ]);
  });

  it("removing a label the PR does not have is not an error; no open PR means one is opened", async () => {
    const b = await brokerWith([], true);
    const r = await b.broker.call(b.ctx, "github.open_pr", { branch: b.branch, base_ref: "main", title: "T", body: "B", labels: { "sf: incomplete": false } });
    expect(r).toMatchObject({ ok: true, content: { number: 9 } });
    expect(b.calls[1]).toMatchObject({ method: "POST", path: "/repos/o/r/pulls" });
  });
});
