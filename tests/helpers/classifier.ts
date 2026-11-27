import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import type { FactoryConfig } from "../../src/core/config.js";
import { LiveSettings, baseFromConfig } from "../../src/core/settings.js";
import type { UserId, WorkerId } from "../../src/core/types.js";
import type { EgressScanner } from "../../src/interfaces/egress-scanner.js";
import type { FactoryStore } from "../../src/interfaces/factory-store.js";
import { skillVersion } from "../../src/runtime/capabilities/capabilities.js";
import { type SkillEvalWiring, runSkillEvalFor } from "../../src/skill-evals.js";
import { readApi } from "../../src/ui/read-routes.js";
import type { ServerDeps, UiRequest } from "../../src/ui/server.js";
import type { Sandbox } from "../../src/interfaces/sandbox.js";
import { NoKeepAwake } from "../../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../../src/impl/clock/fake-clock.js";
import { ControllerRole } from "../../src/runtime/roles/controller-role.js";
import { Worker } from "../../src/worker/index.js";
import { FakeBroker } from "./fakes/broker.js";
import { alice, cleanScanner, config, issueRef, prompts, silent } from "./fakes/config.js";
import { FakeAuth, FakeRunner, FakeSandbox, MemoryStorage } from "./fakes/runner.js";
import { FakeSource } from "./fakes/source.js";
import { newStore } from "./store.js";
import { CLASSIFY_SYSTEM } from "../../src/core/classify-message.js";
import type { LLMProvider, LLMRequest, LLMResponse } from "../../src/interfaces/llm-provider.js";

// Fake LLMs written for the interpreter answer the classifier in front of it (design 04-gate-commands) with this,
// so their scripted interpreter answers stay as they were.

/** `label` as the classifier's answer when `req` is the classifier's request; else null (the request is the interpreter's). */
export function classifierAnswer(req: LLMRequest, label = "command"): LLMResponse | null {
  return req.system === CLASSIFY_SYSTEM ? { text: label, stop_reason: "end", usage: { input_tokens: 1, output_tokens: 1, cost_usd: null } } : null;
}

// The triage outcome with the mode on auto: the setup the triage test files share.
export async function autoTriage(spec: Record<string, unknown>, sandbox?: Sandbox) {
  const cfg: FactoryConfig = { ...config, dials: { spec_gate_min_tier: 1, auto_merge_max_tier: 0 } };
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const source = new FakeSource();
  const settings = new LiveSettings({ config: cfg, base: baseFromConfig(cfg), source: store });
  await store.setSettingOverride({ key: "mode", project: "", value: JSON.stringify("auto"), actor: "local:me@example.com" as UserId });
  const controller = new ControllerRole({ store, source, auth: new FakeAuth(), clock, config: cfg, log: silent, scanner: cleanScanner, repeated_failure_rule: false, settings, ...(sandbox && { sandbox }) });
  const runner = new FakeRunner({ triage: () => ({ output: spec }) });
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox: new FakeSandbox(), runner, broker: new FakeBroker(), storage: new MemoryStorage(),
    clock, config: cfg, prompts, log: silent, scanner: cleanScanner, toolEnv: {}, awake: new NoKeepAwake(),
  });
  source.queue.push({ kind: "item_requested", source: issueRef(1), requester: alice, title: "t", body: "b" });
  await controller.tickIntake();
  expect(await worker.tick()).toBe(true);
  await controller.tickRuns();
  const it = (await store.getWorkItemBySource("github_issue", issueRef(1).id))!;
  return { it, store, source, changes: await store.listStateChanges(it.id) };
}

// Shared by the skill-eval versions test files (design 06-measurement): fakes only, no live model.
export const OWNER = "local:owner" as UserId;
export const REQ: UiRequest = { method: "GET", url: undefined, host: "127.0.0.1" };
export const V1 = "# Review helper\n\nRead the change.\nReview the diff carefully.\n";
export const V2 = "# Review helper\n\nRead the change.\nReview the diff, then the tests.\n";
/** Flags any text holding LEAK. */
export const FLAGGING: EgressScanner = { scan: async (channel, t) => (t.includes("LEAK") ? { clean: false, findings: [{ rule: "test_rule", channel }] } : { clean: true }) };

/** A judge that answers yes when the replay's output names the tests (V2) or the case is CASE-A, else no. */
export class RubricLLM implements LLMProvider {
  async complete(req: LLMRequest): Promise<LLMResponse> {
    const said = req.messages.map((m) => m.content).join("\n");
    const answer = said.includes("then the tests") || said.includes("CASE-A") ? "yes" : "no";
    const parsed = { answers: [{ answer, reason: "ok" }] };
    return { text: JSON.stringify(parsed), parsed, stop_reason: "end", usage: { input_tokens: 1, output_tokens: 1, cost_usd: null } };
  }
}

/** A suite for an imported skill folder with two cases, the folder's two imported versions (v2 current), and the wiring. */
export async function setup(tmp: string) {
  const { store, clock } = await newStore();
  const folder = join(tmp, "skills", "review-helper");
  await mkdir(folder, { recursive: true });
  const skill = folder;
  await store.createSkillEvalSuite({ id: "s1", skill_ref: skill, title: "Review", created_by: OWNER });
  await store.addSkillEvalCase({ id: "c1", suite_id: "s1", input: "CASE-A", expected: ["names the tests"] });
  await store.addSkillEvalCase({ id: "c2", suite_id: "s1", input: "CASE-B", expected: ["names the tests"] });
  await writeFile(join(folder, "SKILL.md"), V1);
  const h1 = await skillVersion(folder);
  await store.recordSkillVersion({ ref_id: "sr_review", folder_hash: h1, text: V1, source: "claude" });
  clock.advance(1000);
  await writeFile(join(folder, "SKILL.md"), V2);
  const h2 = await skillVersion(folder);
  await store.recordSkillVersion({ ref_id: "sr_review", folder_hash: h2, text: V2, source: "claude" });
  // Both gates passed (design 07-self-improvement): v2 is the gate's current version.
  await store.db.run("UPDATE controller_skill_version_gates SET state = 'passed' WHERE ref_id = 'sr_review'");
  const runner = new FakeRunner({ implement: (spec) => ({ output: `${spec.system_prompt}\n${spec.prompt}` }) });
  let n = 0;
  const d: SkillEvalWiring = {
    store, root: tmp, judgePrompt: async () => "JUDGE", repo: { path: config.repo.path, base_branch: config.repo.base_branch }, deny_paths: [".env"], timeout_ms: 1000,
    plugins: async () => ({ sandbox: new FakeSandbox(), runner, llm: new RubricLLM(), scanner: cleanScanner }),
    newId: () => `run${++n}`,
  };
  const run = async (version?: string) => {
    clock.advance(1000);
    const r = await runSkillEvalFor(d, { skill, created_by: OWNER, signal: new AbortController().signal, ...(version !== undefined && { version }) });
    if (!("run" in r)) throw new Error(r.refused);
    return r.run;
  };
  return { store, clock, d, skill, h1, h2, runner, run };
}

export const get = (store: FactoryStore, path: string, scanner: EgressScanner = cleanScanner) =>
  readApi({ store, scanner } as unknown as ServerDeps, new URL(`http://127.0.0.1${path}`), REQ);
export const versionsPath = (skill: string) => `/api/v1/evals/${encodeURIComponent(skill)}/versions`;
export const diffPath = (skill: string, a: string, b: string) => `/api/v1/evals/${encodeURIComponent(skill)}/diff?a=${a}&b=${b}`;
