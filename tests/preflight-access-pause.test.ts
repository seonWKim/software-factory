import { describe, expect, it } from "vitest";
import type { Timestamp, WorkerId } from "../src/core/types.js";
import type { ToolResult } from "../src/interfaces/tool-broker.js";
import { pipeline } from "./helpers/fakes.js";
import { issue, newStore, system, w1 } from "./helpers/store.js";

// Design §5 Restarts (issue #216): a push_access or pr_api preflight check that fails other than with a 401/403 is
// `preflight_access`. It pauses implement and update claims for every worker (its own `preflight_access` row of
// claim_pauses, not the forge_auth row) for auth_pause_ms, with one comment and one log line per pause.

const ACCESS: ToolResult = { ok: false, error_code: "preflight_access", message: "push_access: GitHub answered 404" };
const iso = (ms: number) => new Date(ms).toISOString();
const pauseComments = (f: Awaited<ReturnType<typeof pipeline>>) =>
  f.source.comments.filter((c) => c.marker.startsWith("<!-- factory:preflight-access:"));
const pauseLines = (f: Awaited<ReturnType<typeof pipeline>>) => f.log.lines.filter((l) => l.msg.startsWith("preflight access failed"));

describe("preflight-access pause", () => {
  it("a failed push_access check is a task failure that pauses implement and update claims, not triage or review", async () => {
    const f = await pipeline();
    f.broker.responses["github.preflight"] = [ACCESS];
    const a = await f.submit();
    const start = f.clock.now().getTime();
    await f.step();
    const resume = iso(start + f.config.retry_max_ms);
    expect((await f.runs(a, "implement"))[0]!.outcome).toMatchObject({ status: "failed", error_code: "preflight_access", infra: false });
    expect(await f.store.getClaimPause("preflight_access")).toBe(resume);
    // Its own row: neither the forge-auth nor the rate-limit pause is set.
    expect(await f.store.getClaimPause("forge_auth")).toBeNull();
    expect(await f.store.getClaimPause()).toBeNull();
    expect(f.agentCalls("implement")).toBe(0);

    // Another item's triage still runs; its implement waits.
    const b = await f.submit();
    await f.step();
    expect(await f.runs(b, "triage")).toMatchObject([{ status: "succeeded" }]);
    expect((await f.runs(b, "implement")).map((r) => r.status)).toEqual(["queued"]);

    // Store level: update waits; review and resolve do not.
    const { item: c } = await f.store.createWorkItem(issue(90), system, { enqueue: { kind: "update", idempotency_key: "u" } });
    const { item: d } = await f.store.createWorkItem(issue(91), system, { enqueue: { kind: "review", idempotency_key: "r" } });
    const { item: e } = await f.store.createWorkItem(issue(92), system, { enqueue: { kind: "resolve", idempotency_key: "s" } });
    expect(await f.store.claimRun({ worker_id: w1, kinds: ["update", "implement"], lease_ms: 60_000 })).toBeNull();
    expect((await f.store.claimRun({ worker_id: w1, kinds: ["update", "review"], lease_ms: 60_000 }))?.work_item_id).toBe(d.id);
    expect((await f.store.claimRun({ worker_id: "w9" as WorkerId, kinds: ["update", "resolve"], lease_ms: 60_000 }))?.work_item_id).toBe(e.id);
    expect((await f.store.listRuns(c.id))[0]!.status).toBe("queued");

    // The retry waits for the pause end, the later of it and its backoff.
    expect((await f.runs(a, "implement")).at(-1)).toMatchObject({ status: "queued", not_before: resume });
  });

  it("a failed pr_api check pauses too; a failed base_fetch is still preflight_failed and pauses nothing", async () => {
    const f = await pipeline();
    f.broker.responses["github.preflight"] = [{ ok: false, error_code: "preflight_access", message: "pr_api: GitHub answered 500" }];
    const a = await f.submit();
    await f.step();
    expect((await f.runs(a, "implement"))[0]!.outcome).toMatchObject({ error_code: "preflight_access", detail: expect.stringContaining("pr_api") });
    expect(await f.store.getClaimPause("preflight_access")).not.toBeNull();

    const g = await pipeline();
    g.sandbox.failGit = ["fetch"];
    const b = await g.submit();
    await g.step();
    expect((await g.runs(b, "implement"))[0]!.outcome).toMatchObject({ error_code: "preflight_failed" });
    expect(await g.store.getClaimPause("preflight_access")).toBeNull();
    expect(pauseComments(g)).toHaveLength(0);
  });

  it("no implement claim during the pause; the first claim after it ends succeeds", async () => {
    const f = await pipeline();
    f.broker.responses["github.preflight"] = [ACCESS];
    const a = await f.submit();
    await f.step();
    f.clock.advance(f.config.retry_max_ms - 1);
    expect(await f.w1.tick()).toBe(false);
    expect(await f.w2.tick()).toBe(false);
    f.clock.advance(1);
    expect(await f.w2.tick()).toBe(true);
    await f.controller.tickRuns();
    expect((await f.runs(a, "implement")).map((r) => r.status)).toEqual(["failed", "succeeded"]);
  });

  it("auth_pause_ms sets the pause length", async () => {
    const f = await pipeline({ config: { auth_pause_ms: 5 * 60_000 } });
    f.broker.responses["github.preflight"] = [ACCESS];
    await f.submit();
    const start = f.clock.now().getTime();
    await f.step();
    expect(await f.store.getClaimPause("preflight_access")).toBe(iso(start + 5 * 60_000));
  });

  it("two workers failing push_access at the same moment: one pause row, one comment, one log line", async () => {
    const f = await pipeline();
    const a = await f.submit();
    const b = await f.submit();
    await f.w1.tick();
    await f.w1.tick();
    await f.controller.tickRuns();
    f.broker.responses["github.preflight"] = [ACCESS, ACCESS];
    await Promise.all([f.w1.tick(), f.w2.tick()]);
    await f.controller.tickRuns();
    expect((await f.runs(a, "implement"))[0]!.outcome).toMatchObject({ error_code: "preflight_access" });
    expect((await f.runs(b, "implement"))[0]!.outcome).toMatchObject({ error_code: "preflight_access" });
    expect(pauseComments(f)).toHaveLength(1);
    expect(pauseLines(f)).toHaveLength(1);
    expect(await f.store.getClaimPause("preflight_access")).not.toBeNull();

    // The comment names the check and the time, never the forge's answer.
    const body = pauseComments(f)[0]!.body;
    expect(body).toContain("push_access");
    expect(body).toContain(await f.store.getClaimPause("preflight_access"));
    expect(body).not.toContain("404");
    expect(body).not.toContain("GitHub answered");

    // Applying the same runs again posts nothing new.
    for (const r of [...(await f.runs(a, "implement")), ...(await f.runs(b, "implement"))]) await f.controller.applyRun(r);
    expect(pauseComments(f)).toHaveLength(1);
  });

  it("a failure during the pause moves its end later but posts and logs nothing; one after it ends starts a new pause", async () => {
    const f = await pipeline();
    await f.submit();
    const b = await f.submit();
    await f.w1.tick();
    await f.w1.tick();
    await f.controller.tickRuns();
    // While a's agent runs, w2 takes b's implement, whose push_access check fails: the pause starts there.
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
    f.broker.responses["github.preflight"] = [{ ok: true, content: {} }, ACCESS];
    await f.w1.tick();
    await f.controller.tickRuns();
    await f.controller.tickRuns();
    expect((await f.runs(b, "implement"))[0]!.outcome).toMatchObject({ error_code: "preflight_access" });
    expect(pauseComments(f)).toHaveLength(1);
    expect(pauseComments(f)[0]!.source.id).toBe(b.source.id);
    expect(pauseLines(f)).toHaveLength(1);
    const end1 = await f.store.getClaimPause("preflight_access");

    // During the pause, another failure (written straight to the store, as a second replica would) only moves the end.
    f.clock.advance(1_000);
    const moved = await f.store.pauseClaims(iso(f.clock.now().getTime() + f.config.retry_max_ms) as Timestamp, "preflight_access");
    expect(moved).toMatchObject({ extended: true, started: false });
    expect((await f.store.getClaimPause("preflight_access"))! > end1!).toBe(true);

    // After the pause has ended, a failure starts a new pause: one more comment, one more line.
    f.clock.advance(f.config.retry_max_ms * 2);
    f.broker.responses["github.preflight"] = [ACCESS];
    await f.w1.tick();
    await f.controller.tickRuns();
    expect(pauseComments(f)).toHaveLength(2);
    expect(pauseLines(f)).toHaveLength(2);
  });

  it("two preflight_access failures in a row never block with repeated_failure", async () => {
    const f = await pipeline();
    f.broker.responses["github.preflight"] = [ACCESS, ACCESS];
    const a = await f.submit();
    for (let i = 0; i < 3; i++) {
      await f.step();
      f.clock.advance(f.config.retry_max_ms + 1);
    }
    expect((await f.store.listStateChanges(a.id)).map((c) => c.reason)).not.toContain("repeated_failure");
  });

  it("a 401/403 still uses the forge_auth pause and comment, not this one", async () => {
    const f = await pipeline();
    f.broker.responses["github.preflight"] = [{ ok: false, error_code: "forge_auth", message: "push_access: GitHub refused the credentials (403)" }];
    await f.submit();
    await f.step();
    expect(await f.store.getClaimPause("forge_auth")).not.toBeNull();
    expect(await f.store.getClaimPause("preflight_access")).toBeNull();
    expect(pauseComments(f)).toHaveLength(0);
    expect(f.source.comments.filter((c) => c.marker.startsWith("<!-- factory:forge-auth:"))).toHaveLength(1);
  });

  it("store: the preflight_access pause only moves later and reports started once", async () => {
    const { store, clock } = await newStore();
    const at = (ms: number) => iso(clock.now().getTime() + ms) as Timestamp;
    expect(await store.pauseClaims(at(1000), "preflight_access")).toEqual({ extended: true, started: true, resume_at: at(1000) });
    expect(await store.pauseClaims(at(500), "preflight_access")).toEqual({ extended: false, started: false, resume_at: at(1000) });
    expect(await store.pauseClaims(at(2000), "preflight_access")).toEqual({ extended: true, started: false, resume_at: at(2000) });
    expect(await store.getClaimPause("forge_auth")).toBeNull();
    const results = await Promise.all([at(3000), at(3001)].map((t) => store.pauseClaims(t, "preflight_access")));
    expect(results.filter((r) => r.started)).toHaveLength(0);
  });
});
