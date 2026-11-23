// POST /api/v1/evals/<skill>/runs (src/ui/evals-run-api.ts): Run now on the evals page. One run through runSkillEval
// (src/skill-evals.ts runSkillEvalFor, with its option and suite checks), after the request guards (Origin,
// Content-Type, CSRF token, body size) and the owner check (rules-api.ts ownerOf: approve_spec, then the store's
// owner). The sandbox, runner and judge LLM are fakes: no test calls a model or a remote service.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OwnerAuth } from "../src/core/authorize.js";
import type { LogFields } from "../src/core/log.js";
import type { UserId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import type { EgressScanner } from "../src/interfaces/egress-scanner.js";
import type { LLMProvider, LLMResponse } from "../src/interfaces/llm-provider.js";
import { type SkillEvalWiring, runSkillEvalFor } from "../src/skill-evals.js";
import type { UiEvals } from "../src/ui/evals-api.js";
import { HealthMonitor } from "../src/ui/health.js";
import type { UiPauses } from "../src/ui/pause-api.js";
import { type ServerDeps, type UiRequest, respond } from "../src/ui/server.js";
import { newCsrfToken } from "../src/ui/settings-api.js";
import { POST_ONLY } from "../src/ui/write-routes.js";
import { PROJECT, cleanScanner, config } from "./helpers/fakes/config.js";
import { FakeRunner, FakeSandbox } from "./helpers/fakes/runner.js";
import { newStore } from "./helpers/store.js";

const HOST = "127.0.0.1:4310";
const ORIGIN = `http://${HOST}`;
const OWNER = "local:alice" as UserId;
const OTHER = "local:bob" as UserId;
const SKILL = "skills/tests-first";
const PATH = `/api/v1/evals/${encodeURIComponent(SKILL)}/runs`;
/** Flags any text holding LEAK. */
const FLAGGING: EgressScanner = { scan: async (channel, t) => (t.includes("LEAK") ? { clean: false, findings: [{ rule: "test_rule", channel }] } : { clean: true }) };

/** A judge LLM that answers yes to every check, and counts its calls. */
class YesLLM implements LLMProvider {
  calls = 0;
  async complete(): Promise<LLMResponse> {
    this.calls++;
    const parsed = { answers: [{ answer: "yes", reason: "ok" }] };
    return { text: JSON.stringify(parsed), parsed, stop_reason: "end", usage: { input_tokens: 1, output_tokens: 1, cost_usd: null } };
  }
}

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "evals-run-api-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function setup(opts: { user?: UserId | null; scanner?: EgressScanner; run?: UiEvals["run"] | null } = {}) {
  const clock = new FakeClock("2026-11-24T08:00:00.000Z");
  const { store } = await newStore(clock);
  await store.claimOwner(OWNER);
  await store.createSkillEvalSuite({ id: "s1", skill_ref: SKILL, title: "Tests first", created_by: OWNER });
  await store.addSkillEvalCase({ id: "c1", suite_id: "s1", input: "write a test", expected: ["names the failing test"] });
  const folder = join(tmp, "skills", "tests-first");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "SKILL.md"), "Write the test first.");
  const auth = new OwnerAuth(store);
  const token = newCsrfToken();
  const logged: { msg: string; fields?: LogFields }[] = [];
  const pauses: UiPauses = {
    principal: async () => (opts.user === undefined ? OWNER : opts.user),
    authorize: (user_id) => auth.authorize({ user_id }, "approve_spec", { kind: "project", id: PROJECT.key }),
    csrfToken: token,
    log: { info: (msg, fields) => logged.push({ msg, ...(fields && { fields }) }), warn() {}, error() {} },
  };
  const llm = new YesLLM();
  const wiring: SkillEvalWiring = {
    store, root: tmp, judgePrompt: async () => "JUDGE", repo: { path: config.repo.path, base_branch: config.repo.base_branch }, deny_paths: [".env"], timeout_ms: 1000,
    plugins: async () => ({ sandbox: new FakeSandbox(), runner: new FakeRunner({ implement: (spec) => ({ output: `did ${spec.prompt}` }) }), llm, scanner: cleanScanner }),
    newId: () => "run1",
  };
  const runs: Parameters<NonNullable<UiEvals["run"]>>[1][] = [];
  const run: UiEvals["run"] = opts.run === null ? undefined : (opts.run ?? (async (s, r) => (runs.push(r), runSkillEvalFor({ ...wiring, store: s }, r))));
  const evals = { ...(run && { run }) } as UiEvals;
  const d = { store, clock, scanner: opts.scanner ?? cleanScanner, lease_ms: 300_000, health: new HealthMonitor(async () => [], clock), pauses, evals } as unknown as ServerDeps;
  const post = async (body: unknown, over: Partial<UiRequest> = {}) => {
    const r = await respond(d, { method: "POST", url: PATH, host: HOST, origin: ORIGIN, contentType: "application/json", csrfToken: token, body: JSON.stringify(body), ...over });
    return { status: r.status, value: JSON.parse(r.body) as Record<string, unknown> };
  };
  const stored = () => store.db.all("SELECT id FROM controller_skill_eval_runs");
  return { d, store, post, stored, logged, runs, llm };
}

describe("POST /api/v1/evals/<skill>/runs", () => {
  it("starts one run through runSkillEval as the owner's ID, answers its ID and status only, and logs it with the user ID", async () => {
    const s = await setup();
    const r = await s.post({ model_class: "standard", judge_model_class: "strong", replays: 1 });
    expect(r).toEqual({ status: 200, value: { run_id: "run1", status: "passed" } });
    expect(s.runs).toEqual([expect.objectContaining({ skill: SKILL, created_by: OWNER, model_class: "standard", judge_model_class: "strong", replays: 1 })]);
    expect(await s.store.getSkillEvalRun("run1")).toMatchObject({ created_by: OWNER, model_class: "standard", judge_model_class: "strong" });
    expect(s.llm.calls).toBe(1);
    expect(s.logged).toEqual([{ msg: "skill eval run", fields: { run_id: "run1", status: "passed", actor: OWNER } }]);
  });

  it("takes a model class as stored, and the run gets the judge class of that model", async () => {
    const s = await setup();
    const r = await s.post({ model_class: "strong", judge_model_class: "standard" });
    expect(r.status).toBe(200);
    expect(await s.store.getSkillEvalRun("run1")).toMatchObject({ model_class: "strong", judge_model_class: "standard" });
  });

  it.each([
    ["a model ID, not a stored class", { model_class: "claude-sonnet-5-5" }, /no such model class/],
    ["a judge class that is not the model's", { model_class: "standard", judge_model_class: "cheap" }, /judge runs on strong/],
    ["replays other than 1", { replays: 3 }, /one verdict per case/],
  ])("refuses %s with 409 and its reason, storing no run", async (_name, body, reason) => {
    const s = await setup();
    const r = await s.post(body);
    expect(r.status).toBe(409);
    expect(r.value.error).toMatch(reason);
    expect(await s.stored()).toEqual([]);
    expect(s.llm.calls).toBe(0);
    expect(s.logged).toEqual([]);
  });

  it("refuses a skill with no suite with 409, storing no run", async () => {
    const s = await setup();
    const r = await s.post({}, { url: `/api/v1/evals/${encodeURIComponent("skills/missing")}/runs` });
    expect(r.status).toBe(409);
    expect(r.value.error).toMatch(/no skill eval suite for skills\/missing/);
    expect(await s.stored()).toEqual([]);
  });

  it("answers 400 for a malformed body before the owner check or a run", async () => {
    const s = await setup({ user: OTHER });
    for (const body of [[1], { model_class: 3 }, { replays: "1" }, { replays: 1.5 }]) expect((await s.post(body)).status, JSON.stringify(body)).toBe(400);
    expect(s.runs).toEqual([]);
  });

  it("refuses with 403 and the reason when the page's user is not the owner or there is none, and runs nothing", async () => {
    for (const user of [OTHER, null]) {
      const s = await setup({ user });
      const r = await s.post({});
      expect(r.status).toBe(403);
      expect(r.value.error).toMatch(user === null ? /No factory user/ : /Only the owner starts a skill eval run/);
      expect(s.runs).toEqual([]);
      expect(await s.stored()).toEqual([]);
    }
  });

  it("passes the request guards first: Origin, Content-Type, CSRF token and body size", async () => {
    const s = await setup();
    expect((await s.post({}, { origin: "http://evil.example" })).status).toBe(403);
    expect((await s.post({}, { contentType: "text/plain" })).status).toBe(415);
    for (const csrfToken of [undefined, newCsrfToken()]) expect((await s.post({}, { csrfToken })).value.code).toBe("stale_csrf");
    expect((await s.post({}, { bodyTooLarge: true })).status).toBe(413);
    expect(s.runs).toEqual([]);
    expect(await s.stored()).toEqual([]);
  });

  it("every string in the answer and in a refusal passes the Withholder", async () => {
    const leaky = await setup({ scanner: FLAGGING, run: async () => ({ run: { id: "LEAK-1", status: "LEAK" } }) });
    const ok = await leaky.post({});
    expect(ok.status).toBe(200);
    expect(JSON.stringify(ok.value)).not.toContain("LEAK");
    const refusing = await setup({ scanner: FLAGGING, run: async () => ({ refused: "LEAK in the reason" }) });
    const no = await refusing.post({});
    expect(no.status).toBe(409);
    expect(no.value.error).not.toContain("LEAK");
  });

  it("is in the write route table and POST_ONLY; without a run function it is a 405, and the GET runs read is unchanged", async () => {
    expect(POST_ONLY).toContain("evals run");
    const off = await setup({ run: null });
    expect((await off.post({})).status).toBe(405);
    const s = await setup();
    await s.post({});
    const read = await respond(s.d, { method: "GET", url: PATH, host: HOST });
    expect(read.status).toBe(200);
    expect((JSON.parse(read.body) as { runs: { id: string }[] }).runs.map((x) => x.id)).toContain("run1");
  });
});
