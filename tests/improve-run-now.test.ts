// The Health panel's Run now (design §7 and §9, issue #508): POST /api/v1/improve/run queues one manual improve
// run behind the write guards and the approver check (approve_spec over local grants); the button shows only to
// a user who may approve. Solo: a local store and no source plugin.

import { describe, expect, it } from "vitest";
import { enqueueImprove, listImproveRuns } from "../src/core/improver.js";
import type { RunId, Timestamp, UserId, WorkerId } from "../src/core/types.js";
import { OwnerAuth } from "../src/core/authorize.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { HealthMonitor, RUN_NOW_SCRIPT_HASH } from "../src/ui/health.js";
import { IMPROVE_RUN_PATH } from "../src/ui/improve-api.js";
import type { UiPauses } from "../src/ui/pause-api.js";
import { type PauseDeps, type UiRequest, respond } from "../src/ui/server.js";
import { type UiSettings, newCsrfToken } from "../src/ui/settings-api.js";
import { PROJECT } from "./helpers/fakes.js";
import { newStore } from "./helpers/store.js";

const HOST = "127.0.0.1:4310";
const ORIGIN = `http://${HOST}`;
const APPROVER = "local:alice" as UserId;
const REQUESTER = "local:bob" as UserId;

async function setup(opts: { user?: UserId | null; wired?: boolean } = {}) {
  const clock = new FakeClock("2026-03-04T08:00:00.000Z");
  const { store } = await newStore(clock);
  await store.claimOwner(APPROVER);
  const auth = new OwnerAuth(store);
  const logged: string[] = [];
  const token = newCsrfToken();
  const pauses: UiPauses = {
    principal: async () => (opts.user === undefined ? APPROVER : opts.user),
    authorize: (user_id) => auth.authorize({ user_id, attributes: {} }, "approve_spec", { kind: "project", id: PROJECT.key }),
    csrfToken: token,
    log: { info: (msg) => void logged.push(msg), warn: () => {}, error: () => {} },
  };
  const settings = { repo: { owner: "o", name: "r" }, actor: APPROVER, resolveProject: async () => PROJECT, csrfToken: token } as unknown as UiSettings;
  const d: PauseDeps = {
    store, clock, scanner: new PatternEgressScanner(async () => []), lease_ms: 300_000, health: new HealthMonitor(async () => [], clock),
    ...(opts.wired === false ? {} : { pauses, settings }),
  };
  return { d, store, clock, token, logged, runs: () => listImproveRuns(store, PROJECT.key) };
}

function post(token: string, over: Partial<UiRequest> = {}): UiRequest {
  return { method: "POST", url: IMPROVE_RUN_PATH, host: HOST, origin: ORIGIN, contentType: "application/json", csrfToken: token, body: "{}", ...over };
}

const parse = (r: { body: string }) => JSON.parse(r.body);

describe("POST /api/v1/improve/run", () => {
  it("an approver's POST queues one manual improve run through enqueueImprove and returns its run id", async () => {
    const { d, token, runs, logged } = await setup();
    const r = await respond(d, post(token));
    expect(r.status).toBe(200);
    const [run] = await runs();
    expect(parse(r)).toEqual({ run_id: run!.id });
    expect(run!.idempotency_key).toMatch(/:manual:/);
    expect(run!.input?.improve).toEqual({ window_start: "2026-03-03T08:00:00.000Z", window_end: "2026-03-04T08:00:00.000Z" });
    expect((await runs()).map((x) => x.id)).toEqual([run!.id]);
    expect(logged).toEqual(["improve run queued"]);
  });

  it("a requester's POST is refused with 403 and queues nothing", async () => {
    const { d, token, runs } = await setup({ user: REQUESTER });
    const r = await respond(d, post(token));
    expect(r.status).toBe(403);
    expect(parse(r).error).toContain("approve_spec");
    expect(await runs()).toEqual([]);
  });

  it("no factory user on the page: 403, nothing queued", async () => {
    const { d, token, runs } = await setup({ user: null });
    expect((await respond(d, post(token))).status).toBe(403);
    expect(await runs()).toEqual([]);
  });

  it("a POST while an improve run is queued or running is refused with a reply and queues nothing", async () => {
    const { d, store, clock, token, runs } = await setup();
    const { run } = await enqueueImprove({ store, clock }, PROJECT.key, "daily");
    clock.advance(1_000);
    const queued = await respond(d, post(token));
    expect(queued.status).toBe(409);
    expect(parse(queued)).toMatchObject({ run_id: run.id });
    expect(parse(queued).error).toContain("queued");
    await store.claimRun({ worker_id: "w" as WorkerId, kinds: ["improve"], lease_ms: 60_000 });
    const running = await respond(d, post(token));
    expect(running.status).toBe(409);
    expect(parse(running).error).toContain("running");
    expect((await runs()).map((x) => x.id)).toEqual([run.id]);
  });

  it("goes through the write guards: Host, Origin, Content-Type and the CSRF token, before any store write", async () => {
    const { d, token, runs } = await setup();
    const cases: [Partial<UiRequest>, number][] = [
      [{ host: "evil.example" }, 403],
      [{ origin: "http://evil.example" }, 403],
      [{ origin: undefined }, 403],
      [{ contentType: "text/plain" }, 415],
      [{ csrfToken: undefined }, 403],
      [{ csrfToken: "stale" }, 403],
      [{ body: "not json" }, 400],
    ];
    for (const [over, status] of cases) expect((await respond(d, post(token, over))).status, JSON.stringify(over)).toBe(status);
    expect(await runs()).toEqual([]);
  });

  it("not wired (no owner check): a POST is a 405 and queues nothing", async () => {
    const { d, token, runs } = await setup({ wired: false });
    expect((await respond(d, post(token))).status).toBe(405);
    expect(await runs()).toEqual([]);
  });
});

describe("Health panel: Run now", () => {
  const classic = (d: PauseDeps) => respond(d, { method: "GET", url: "/classic", host: HOST });
  const health = (body: string) => /<section id="health">[\s\S]*?<\/section>/.exec(body)![0];

  it("shows the button, with the token, to a user who may approve; the page's CSP allows its script", async () => {
    const { d, token } = await setup();
    const r = await classic(d);
    expect(health(r.body)).toContain(`id="improve-run-now" data-csrf="${token}"`);
    expect(r.headers["content-security-policy"]).toContain(`'${RUN_NOW_SCRIPT_HASH}'`);
  });

  it("shows no button to a requester, to no user, or when the route is not wired", async () => {
    for (const opts of [{ user: REQUESTER }, { user: null }, { wired: false }]) {
      const { d } = await setup(opts);
      const r = await classic(d);
      expect(health(r.body), JSON.stringify(opts)).not.toContain("improve-run-now");
      expect(r.headers["content-security-policy"]).not.toContain(RUN_NOW_SCRIPT_HASH);
    }
  });
});

describe("GET /api/v1/rules: improve (design 07-self-improvement, 2026-11-16)", () => {
  const rules = async (d: PauseDeps) => parse(await respond(d, { method: "GET", url: "/api/v1/rules", host: HOST })).improve;
  /** A GitHub-token-shaped string the pattern scanner flags as `github_token`. */
  const SECRET = `ghp_${"c".repeat(36)}`;

  it("no report yet gives null; Run now with its token only for a user who may approve", async () => {
    const { d, token } = await setup();
    expect(await rules(d)).toEqual({ report: null, run_now: true, csrf_token: token });
    for (const opts of [{ user: REQUESTER }, { user: null }, { wired: false }]) {
      const other = await setup(opts);
      expect(await rules(other.d), JSON.stringify(opts)).toEqual({ report: null, run_now: false, csrf_token: null });
    }
  });

  it("the latest report: window, counts and each group's draft and filing, every text through the Withholder", async () => {
    const { d, store, clock } = await setup();
    const { run } = await enqueueImprove({ store, clock }, PROJECT.key, "daily");
    const g = { detail: "npm test exited #", run_ids: ["r1", "r2"] as RunId[], work_item_ids: [run.work_item_id] };
    await store.recordImproveReport({
      run_id: run.id, project: PROJECT.key, window_start: "2026-03-03T08:00:00.000Z" as Timestamp, window_end: "2026-03-04T08:00:00.000Z" as Timestamp,
      groups: [
        { ...g, error_code: "checks_failed", draft: { status: "drafted", cause: "a flaky port", fix: `rotate ${SECRET}`, touches: [], touches_prompts_or_gate: false },
          filing: { status: "filed", ref: { type: "local", id: "local-1", link: "local:local-1" } } },
        { ...g, error_code: "no_commits", draft: { status: "skipped", reason: "call_cap" }, filing: { status: "skipped", reason: "issue_cap" } },
        { ...g, error_code: "agent_timed_out" },
      ],
      patterns: [{ ...g, error_code: "lonely", run_ids: ["r9" as RunId] }],
    });
    const { report } = await rules(d);
    expect(report).toMatchObject({ window_start: "2026-03-03T08:00:00.000Z", window_end: "2026-03-04T08:00:00.000Z", runs: 6, patterns: 1 });
    expect(report.groups.map((x: { error_code: string }) => x.error_code)).toEqual(["checks_failed", "no_commits", "agent_timed_out"]);
    expect(report.groups[0]).toEqual({
      error_code: "checks_failed", detail: "npm test exited #", runs: 2,
      draft: { cause: "a flaky port", fix: "[withheld: github_token]", note: null }, filing: "filed: local:local-1",
    });
    expect(report.groups[1]).toMatchObject({ draft: { cause: null, fix: null, note: "skipped (call_cap)" }, filing: "skipped (issue_cap)" });
    expect(report.groups[2]).toMatchObject({ draft: null, filing: null });
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });
});
