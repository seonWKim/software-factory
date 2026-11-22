// The Proposals page's routes (design 09-dashboard-proposals, issue #496): GET /api/v1/proposals lists the improve run's
// entity proposals with their evidence; POST /api/v1/proposals/verdict takes promote, reject or hold behind the write
// guards (Host, Origin, Content-Type, CSRF token, body size, JSON), then the approver check (approve_spec), and only then
// one conditional store write. A second verdict on a decided proposal answers unchanged. Solo: a local store, no source.

import { describe, expect, it } from "vitest";
import { IMPROVER_DEFAULTS, proposeChanges } from "../src/core/proposals.js";
import type { ImproveReport, RunId, UserId, WorkItemId } from "../src/core/types.js";
import { OwnerAuth } from "../src/core/authorize.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { HealthMonitor } from "../src/ui/health.js";
import { PROPOSALS_PATH, PROPOSAL_VERDICT_PATH } from "../src/ui/improve-api.js";
import type { UiPauses } from "../src/ui/pause-api.js";
import { type PauseDeps, type UiRequest, respond } from "../src/ui/server.js";
import { type UiSettings, newCsrfToken } from "../src/ui/settings-api.js";
import { PROJECT, cleanScanner } from "./helpers/fakes/config.js";
import { newStore } from "./helpers/store.js";

const HOST = "127.0.0.1:4310";
const ORIGIN = `http://${HOST}`;
const OWNER = "local:alice" as UserId;
const OTHER = "local:bob" as UserId;

async function setup(opts: { user?: UserId | null; project?: string } = {}) {
  const clock = new FakeClock("2026-03-04T08:00:00.000Z");
  const { store } = await newStore(clock);
  await store.claimOwner(OWNER);
  const auth = new OwnerAuth(store);
  const token = newCsrfToken();
  const pauses: UiPauses = {
    principal: async () => (opts.user === undefined ? OWNER : opts.user),
    authorize: (user_id) => auth.authorize({ user_id }, "approve_spec", { kind: "project", id: PROJECT.key }),
    csrfToken: token,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  };
  const settings = { repo: { owner: "o", name: "r" }, actor: OWNER, resolveProject: async () => PROJECT, csrfToken: token } as unknown as UiSettings;
  const d: PauseDeps = { store, clock, scanner: new PatternEgressScanner(async () => []), lease_ms: 300_000, health: new HealthMonitor(async () => [], clock), pauses, settings };
  const report = {
    id: "ir_1", run_id: "run_1", project: opts.project ?? PROJECT.key, patterns: [], created_at: "2026-03-04T00:00:00.000Z",
    groups: [{ error_code: "checks_failed", detail: "npm test", run_ids: ["r1", "r2"] as RunId[], work_item_ids: ["w1", "w2"] as WorkItemId[] }],
  } as unknown as ImproveReport;
  const [proposal] = await proposeChanges({
    store, scanner: cleanScanner, file_text: "REVIEW", config: IMPROVER_DEFAULTS,
    llm: { complete: async () => ({ text: "", parsed: { why: "w", edits: [{ find: "REVIEW", replace: "REVIEW!" }] }, stop_reason: "end", usage: { input_tokens: 0, output_tokens: 0, cost_usd: null } }) },
    replay: async (p) => ({ cases: [{ id: "1", expect: "should_flag", verdict: p.endsWith("!") ? "bug" : "pass" }], catch_rate: p.endsWith("!") ? 1 : 0, false_alarm_rate: null }),
  }, report);
  return { d, store, token, id: proposal!.id };
}

const post = (token: string, body: unknown, over: Partial<UiRequest> = {}): UiRequest => ({
  method: "POST", url: PROPOSAL_VERDICT_PATH, host: HOST, origin: ORIGIN, contentType: "application/json", csrfToken: token, body: JSON.stringify(body), ...over,
});
const parse = (r: { body: string }) => JSON.parse(r.body);

describe("GET /api/v1/proposals", () => {
  it("lists each proposal with its diff and before and after evidence, and the token for a user who may decide", async () => {
    const { d, token, id } = await setup();
    const r = await respond(d, { method: "GET", url: PROPOSALS_PATH, host: HOST });
    expect(r.status).toBe(200);
    const v = parse(r);
    expect(v.csrf_token).toBe(token);
    expect(v.proposals).toEqual([expect.objectContaining({
      id, state: "pending", file: "prompts/review.md", run_count: 2, needs_human_merge: true, filed: false,
      diff: expect.stringContaining("+REVIEW!"), before: expect.objectContaining({ catch_rate: 0 }), after: expect.objectContaining({ catch_rate: 1 }),
    })]);
  });

  it("gives no token to a user who may not decide", async () => {
    const { d } = await setup({ user: OTHER });
    expect(parse(await respond(d, { method: "GET", url: PROPOSALS_PATH, host: HOST })).csrf_token).toBeNull();
  });
});

describe("POST /api/v1/proposals/verdict", () => {
  it.each([["promote", "promoted"], ["reject", "rejected"], ["hold", "held"]])("%s sets the proposal's state and nothing else", async (verdict, state) => {
    const { d, store, token, id } = await setup();
    const before = (await store.getProposal(id))!;
    const r = await respond(d, post(token, { id, verdict }));
    expect(r.status).toBe(200);
    expect(parse(r)).toEqual({ id, state, unchanged: false });
    expect(await store.getProposal(id)).toEqual({ ...before, state, decided_by: OWNER, decided_at: "2026-03-04T08:00:00.000Z" });
  });

  it("a second verdict on a decided proposal changes nothing and answers unchanged", async () => {
    const { d, store, token, id } = await setup();
    await respond(d, post(token, { id, verdict: "reject" }));
    const decided = await store.getProposal(id);
    for (const verdict of ["reject", "promote", "hold"]) {
      const r = await respond(d, post(token, { id, verdict }));
      expect(r.status).toBe(200);
      expect(parse(r)).toEqual({ id, state: "rejected", unchanged: true });
    }
    expect(await store.getProposal(id)).toEqual(decided);
  });

  it("a user without approve_spec, or none, is refused with 403 and nothing is written", async () => {
    for (const user of [OTHER, null]) {
      const { d, store, token, id } = await setup({ user });
      const r = await respond(d, post(token, { id, verdict: "promote" }));
      expect(r.status).toBe(403);
      expect((await store.getProposal(id))!.state).toBe("pending");
    }
  });

  it("a proposal of another project is refused with 404 and nothing is written, though the user may decide on the configured one", async () => {
    const { d, store, token, id } = await setup({ project: "local:local:other-project" });
    for (const verdict of ["promote", "reject", "hold"]) {
      const r = await respond(d, post(token, { id, verdict }));
      expect(r.status).toBe(404);
    }
    expect((await store.getProposal(id))!).toEqual(expect.objectContaining({ state: "pending", decided_by: null, decided_at: null }));
  });

  it("checks Host, Origin, Content-Type, the CSRF token, body size and JSON before any store write", async () => {
    const { d, store, token, id } = await setup();
    const cases: [Partial<UiRequest>, number][] = [
      [{ host: "evil.example" }, 403],
      [{ origin: "http://evil.example" }, 403],
      [{ origin: undefined }, 403],
      [{ contentType: "text/plain" }, 415],
      [{ csrfToken: undefined }, 403],
      [{ csrfToken: "stale" }, 403],
      [{ bodyTooLarge: true }, 413],
      [{ body: "not json" }, 400],
    ];
    for (const [over, status] of cases) expect((await respond(d, post(token, { id, verdict: "promote" }, over))).status, JSON.stringify(over)).toBe(status);
    expect((await respond(d, post(token, { id, verdict: "approve" }))).status).toBe(400);
    expect((await respond(d, post(token, { id: "prop_none", verdict: "promote" }))).status).toBe(404);
    expect((await store.getProposal(id))!.state).toBe("pending");
  });
});
