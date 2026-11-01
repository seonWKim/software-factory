import { describe, expect, it } from "vitest";
import type { Timestamp, WorkItemId, WorkerId } from "../src/core/types.js";
import { GitHubToolBroker, forgeAuthRefused } from "../src/impl/broker/github-tool-broker.js";
import { GitHubError, type GitHubClient } from "../src/impl/github/github-client.js";
import type { GitHubCredentials } from "../src/interfaces/github-credentials.js";
import type { ToolResult } from "../src/interfaces/tool-broker.js";
import { cleanScanner, pipeline } from "./helpers/fakes.js";
import { issue, newStore, system, w1 } from "./helpers/store.js";

// Design §5 Restarts: a 401 or 403 from the forge pauses implement-type claims (implement and update) for every
// worker, for auth_pause_ms (default retry_max_ms). Other run kinds go on. One comment and one log line per pause.

const AUTH: ToolResult = { ok: false, error_code: "forge_auth", message: "push_access: GitHub refused the credentials (403)" };
const iso = (ms: number) => new Date(ms).toISOString();

describe("forge-auth pause", () => {
  it("a 401/403 in the preflight pauses implement and update claims for all workers, not triage or review", async () => {
    const f = await pipeline();
    f.broker.responses["github.preflight"] = [AUTH];
    const a = await f.submit();
    const start = f.clock.now().getTime();
    await f.step();
    const resume = iso(start + f.config.retry_max_ms);
    expect(await f.store.getClaimPause("forge_auth")).toBe(resume);
    expect(await f.store.getClaimPause()).toBeNull(); // the rate-limit pause is a separate row
    expect(f.agentCalls("implement")).toBe(0);

    // Another item's triage still runs; its implement waits.
    const b = await f.submit();
    await f.step();
    expect(await f.runs(b, "triage")).toMatchObject([{ status: "succeeded" }]);
    expect((await f.runs(b, "implement")).map((r) => r.status)).toEqual(["queued"]);

    // Store level: update waits, review does not.
    const { item: c } = await f.store.createWorkItem(issue(90), system, { enqueue: { kind: "update", idempotency_key: "u" } });
    const { item: d } = await f.store.createWorkItem(issue(91), system, { enqueue: { kind: "review", idempotency_key: "r" } });
    expect(await f.store.claimRun({ worker_id: w1, kinds: ["update", "implement"], lease_ms: 60_000 })).toBeNull();
    expect((await f.store.claimRun({ worker_id: w1, kinds: ["update", "review"], lease_ms: 60_000 }))?.work_item_id).toBe(d.id);
    expect((await f.store.listRuns(c.id))[0]!.status).toBe("queued");

    // The retry waits for the pause, whatever its backoff.
    expect((await f.runs(a, "implement")).at(-1)).toMatchObject({ status: "queued", not_before: resume });
  });

  it("no claim is made during the pause, and the first claim after it ends succeeds", async () => {
    const f = await pipeline();
    f.broker.responses["github.preflight"] = [AUTH];
    const a = await f.submit();
    const start = f.clock.now().getTime();
    await f.step();
    f.clock.advance(f.config.retry_max_ms - 1);
    expect(await f.w1.tick()).toBe(false);
    expect(await f.w2.tick()).toBe(false);
    expect((await f.runs(a, "implement")).map((r) => r.status)).toEqual(["failed", "queued"]);
    f.clock.advance(1);
    expect(f.clock.now().getTime()).toBe(start + f.config.retry_max_ms);
    expect(await f.w2.tick()).toBe(true);
    await f.controller.tickRuns();
    expect((await f.runs(a, "implement")).map((r) => r.status)).toEqual(["failed", "succeeded"]);
    await f.step();
    expect(await f.item(a)).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending" });
  });

  it("auth_pause_ms sets the pause length", async () => {
    const f = await pipeline({ config: { auth_pause_ms: 5 * 60_000 } });
    f.broker.responses["github.preflight"] = [AUTH];
    await f.submit();
    const start = f.clock.now().getTime();
    await f.step();
    expect(await f.store.getClaimPause("forge_auth")).toBe(iso(start + 5 * 60_000));
  });

  it("a 401/403 on the push or on the PR pauses too", async () => {
    for (const tool of ["github.push_branch", "github.open_pr"]) {
      const f = await pipeline();
      f.broker.responses[tool] = [AUTH];
      const a = await f.submit();
      await f.step();
      expect((await f.runs(a, "implement"))[0]!.outcome).toMatchObject({ status: "failed", error_code: "forge_auth", infra: false });
      expect(await f.store.getClaimPause("forge_auth")).not.toBeNull();
      expect(await f.item(a)).toMatchObject({ stage: "RUNNING", blocked_on: "none" });
    }
  });

  it("each pause posts one comment on the item whose run started it and logs one line", async () => {
    const f = await pipeline();
    const a = await f.submit();
    const b = await f.submit();
    // Triage both: two implement runs queued.
    await f.w1.tick();
    await f.w1.tick();
    await f.controller.tickRuns();
    // While a's agent runs, w2 takes b's implement, whose preflight is refused: the pause starts there.
    let first = true;
    f.runner.script.implement = async () => {
      if (first) {
        first = false;
        f.clock.advance(1_000);
        await f.w2.tick();
        f.clock.advance(1_000);
      }
      return { output: { summary: "s", next_steps: "n" } };
    };
    f.broker.responses["github.preflight"] = [{ ok: true, content: {} }, AUTH];
    // Then a's push is refused too, during the same pause (it moves the pause later, but starts none).
    f.broker.responses["github.push_branch"] = [AUTH];
    await f.w1.tick();
    await f.controller.tickRuns();
    await f.controller.tickRuns();

    expect((await f.runs(a, "implement"))[0]!.outcome).toMatchObject({ error_code: "forge_auth" });
    expect((await f.runs(b, "implement"))[0]!.outcome).toMatchObject({ error_code: "forge_auth" });
    const pauseComments = () => f.source.comments.filter((c) => c.marker.startsWith("<!-- factory:forge-auth:"));
    expect(pauseComments()).toHaveLength(1);
    expect(pauseComments()[0]!.source.id).toBe(b.source.id);
    expect(pauseComments()[0]!.body).toContain("401 or 403");
    const lines = () => f.log.lines.filter((l) => l.msg.startsWith("forge auth refused"));
    expect(lines()).toHaveLength(1);

    // Applying the same runs again posts nothing new.
    for (const r of [...(await f.runs(a, "implement")), ...(await f.runs(b, "implement"))]) await f.controller.applyRun(r);
    expect(pauseComments()).toHaveLength(1);

    // A refusal after the pause ended starts a new pause: one more comment, one more line.
    f.clock.advance(f.config.retry_max_ms + 1);
    f.runner.script.implement = () => ({ output: { summary: "s", next_steps: "n" } });
    f.broker.responses["github.preflight"] = [AUTH];
    await f.w1.tick();
    await f.controller.tickRuns();
    expect(pauseComments()).toHaveLength(2);
    expect(lines()).toHaveLength(2);
  });

  it("the rate-limit pause still stops every claim", async () => {
    const { store, clock } = await newStore();
    await store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "t" } });
    await store.pauseClaims(iso(clock.now().getTime() + 1000) as Timestamp);
    expect(await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: 60_000 })).toBeNull();
    expect(await store.getClaimPause("forge_auth")).toBeNull();
  });

  it("the forge-auth pause only ever moves later and reports whether this call moved it", async () => {
    const { store, clock } = await newStore();
    const at = (ms: number) => iso(clock.now().getTime() + ms) as Timestamp;
    expect(await store.pauseClaims(at(1000), "forge_auth")).toEqual({ extended: true, resume_at: at(1000) });
    expect(await store.pauseClaims(at(500), "forge_auth")).toEqual({ extended: false, resume_at: at(1000) });
    expect(await store.pauseClaims(at(2000), "forge_auth")).toEqual({ extended: true, resume_at: at(2000) });
    expect(await store.getClaimPause()).toBeNull();
  });
});

describe("the broker maps forge 401/403 to forge_auth", () => {
  async function brokerWith(request: (method: string, path: string) => unknown) {
    const { store } = await newStore();
    const { item } = await store.createWorkItem(issue(1), system, { enqueue: { kind: "implement", idempotency_key: "k" } });
    const run = (await store.claimRun({ worker_id: "w" as WorkerId, kinds: ["implement"], lease_ms: 60_000 }))!;
    const client = { request: async (m: string, p: string) => request(m, p) } as unknown as GitHubClient;
    const broker = new GitHubToolBroker({
      client, credentials: { token: async () => null } as unknown as GitHubCredentials, store, scanner: cleanScanner,
      clock: { now: () => new Date() } as never, repo: { owner: "o", name: "r" }, branchPrefix: "factory/",
    });
    return { broker, ctx: { run_id: run.id, work_item_id: item.id as WorkItemId, lease_token: run.lease!.token }, branch: `factory/${item.id}` };
  }

  it("open_pr: a 401 or 403 is a forge_auth result, not a thrown exception", async () => {
    for (const status of [401, 403]) {
      const b = await brokerWith(() => {
        throw new GitHubError(status, `GitHub POST /repos/o/r/pulls → ${status} Resource not accessible by integration`);
      });
      const r = await b.broker.call(b.ctx, "github.open_pr", { branch: b.branch, base_ref: "main", title: "t", body: "b" });
      expect(r).toMatchObject({ ok: false, error_code: "forge_auth" });
    }
  });

  it("open_pr: other errors still throw as before", async () => {
    const b = await brokerWith(() => {
      throw new GitHubError(422, "GitHub POST → 422");
    });
    await expect(b.broker.call(b.ctx, "github.open_pr", { branch: b.branch, base_ref: "main", title: "t", body: "b" })).rejects.toThrow("422");
  });

  it("push: git's 401/403 and auth messages are recognized; other push errors are not", () => {
    expect(forgeAuthRefused("fatal: unable to access 'https://github.com/o/r/': The requested URL returned error: 403")).toBe(true);
    expect(forgeAuthRefused("fatal: unable to access 'https://github.com/o/r/': The requested URL returned error: 401")).toBe(true);
    expect(forgeAuthRefused("remote: Permission to o/r.git denied to app[bot].")).toBe(true);
    expect(forgeAuthRefused("remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/o/r/'")).toBe(true);
    expect(forgeAuthRefused("! [rejected] HEAD -> factory/x (non-fast-forward)")).toBe(false);
    expect(forgeAuthRefused("fatal: unable to access: The requested URL returned error: 500")).toBe(false);
  });
});
