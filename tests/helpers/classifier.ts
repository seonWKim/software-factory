import { expect } from "vitest";
import type { FactoryConfig } from "../../src/core/config.js";
import { LiveSettings, baseFromConfig } from "../../src/core/settings.js";
import type { UserId, WorkerId } from "../../src/core/types.js";
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
import type { LLMRequest, LLMResponse } from "../../src/interfaces/llm-provider.js";

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
