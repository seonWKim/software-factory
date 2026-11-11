// The owner's message style (design 04-agents): `message_style`, read live, follows the role instructions of every
// model call that writes owner text (triage, implement, review, resolve, improve drafts, chat answers). Empty: every
// prompt and request is byte-identical to the one without the setting. It never changes schemas, tools or commands.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commandFooter } from "../src/core/commands.js";
import { enqueueImprove } from "../src/core/improver.js";
import { interpretRequest, openItems } from "../src/core/interpret.js";
import { MESSAGE_STYLE_LABEL, withMessageStyle } from "../src/core/message-style.js";
import { improvePrompts } from "../src/core/scorer.js";
import { LiveSettings, baseFromConfig } from "../src/core/settings.js";
import type { Prompts } from "../src/core/config.js";
import type { RunId, WorkerId } from "../src/core/types.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import type { AgentRunSpec } from "../src/interfaces/agent-runner.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import type { LLMProvider, LLMRequest, LLMResponse } from "../src/interfaces/llm-provider.js";
import { packPrompts } from "../src/packs/packs.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { Worker } from "../src/worker/index.js";
import {
  FakeAuth, FakeBroker, FakeForge, FakeRunner, FakeSandbox, FakeSource, MemoryStorage, PROJECT, alice, cleanScanner, config, issueRef, prompts, silent, triageSpec,
} from "./helpers/fakes.js";
import { issue, newStore, system } from "./helpers/store.js";

const STYLE = "Short sentences. Plain words, no jargon. Lead with the decision.";
const ROLES = ["triage", "implement", "review", "resolve"] as const;

const count = (text: string, part: string) => text.split(part).length - 1;

/** The settings a running process reads: the config plus the overrides stored in `store`, refreshed on demand. */
const live = (store: FactoryStore) => new LiveSettings({ config, base: baseFromConfig(config), source: store, log: silent });

async function setStyle(store: FactoryStore, style: string) {
  await store.setSettingOverride({ key: "message_style", project: "", value: JSON.stringify(style), actor: "local:owner" });
}

describe("withMessageStyle", () => {
  it("empty or blank: the prompt unchanged, byte for byte", () => {
    for (const p of ["TRIAGE", "TRIAGE\n", "a\n\nb  \n"]) {
      expect(withMessageStyle(p, "")).toBe(p);
      expect(withMessageStyle(p, "  \n ")).toBe(p);
    }
  });

  it("a style: the prompt first, then the label, then the style, once", () => {
    const out = withMessageStyle("ROLE RULES\n", STYLE);
    expect(out.startsWith("ROLE RULES")).toBe(true);
    expect(count(out, STYLE)).toBe(1);
    expect(count(out, MESSAGE_STYLE_LABEL)).toBe(1);
    expect(out.indexOf(MESSAGE_STYLE_LABEL)).toBeGreaterThan(out.indexOf("ROLE RULES"));
    expect(out.indexOf(STYLE)).toBeGreaterThan(out.indexOf(MESSAGE_STYLE_LABEL));
    expect(MESSAGE_STYLE_LABEL).toContain("owner's style preference");
  });
});

function worker(store: FactoryStore, opts: { settings?: LiveSettings; prompts?: Prompts; runner?: FakeRunner; llm?: LLMProvider; clock?: FakeClock; storage?: MemoryStorage } = {}) {
  return new Worker({
    id: "w1" as WorkerId, store, sandbox: new FakeSandbox(), runner: opts.runner ?? new FakeRunner({}), broker: new FakeBroker(), storage: opts.storage ?? new MemoryStorage(),
    clock: opts.clock ?? new FakeClock(), config, prompts: opts.prompts ?? prompts, log: silent, scanner: cleanScanner, toolEnv: { PATH: "/usr/bin" }, awake: new NoKeepAwake(),
    ...(opts.settings ? { settings: opts.settings } : {}), ...(opts.llm ? { llm: opts.llm } : {}),
  });
}

describe("agent roles: the system prompt each run gets", () => {
  it("empty (the default): each role's system prompt and tools are those of a worker with no settings, byte for byte", async () => {
    const { store } = await newStore();
    const settings = live(store);
    await settings.refresh();
    const today = worker(store);
    const withSettings = worker(store, { settings });
    for (const role of ROLES) {
      const a = await today.roleSpec(role);
      const b = await withSettings.roleSpec(role);
      expect(b.system_prompt, role).toBe(a.system_prompt);
      expect(b.system_prompt, role).toBe(prompts[role]);
      expect(b.tools, role).toEqual(a.tools);
    }
  });

  it("set: each role's prompt is its instructions, then the style once, labelled; the tools stay the same", async () => {
    const { store } = await newStore();
    await setStyle(store, STYLE);
    const settings = live(store);
    await settings.refresh();
    const w = worker(store, { settings });
    const plain = worker(store);
    for (const role of ROLES) {
      const s = await w.roleSpec(role);
      expect(s.system_prompt, role).toBe(withMessageStyle(prompts[role]!, STYLE));
      expect(count(s.system_prompt, STYLE), role).toBe(1);
      expect(s.system_prompt.indexOf(STYLE), role).toBeGreaterThan(s.system_prompt.indexOf(prompts[role]!) + prompts[role]!.length);
      expect(s.tools, role).toEqual((await plain.roleSpec(role)).tools);
    }
  });

  it("triage: the style comes after the owner-defaults, which come after the triage instructions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-style-"));
    mkdirSync(join(dir, "prompts"));
    for (const [name, text] of [["triage", "TRIAGE RULES\n"], ["implement", "IMPLEMENT\n"], ["review", "REVIEW\n"], ["owner-defaults", "OWNER DEFAULTS\n"]]) {
      writeFileSync(join(dir, "prompts", `${name}.md`), text!);
    }
    const packed = await packPrompts([{ layer: "base", dir }], (t) => t);
    const { store } = await newStore();
    await setStyle(store, STYLE);
    const settings = live(store);
    await settings.refresh();
    const p = (await worker(store, { settings, prompts: packed }).roleSpec("triage")).system_prompt;
    expect(count(p, STYLE)).toBe(1);
    expect(p.indexOf("TRIAGE RULES")).toBeLessThan(p.indexOf("OWNER DEFAULTS"));
    expect(p.indexOf("OWNER DEFAULTS")).toBeLessThan(p.indexOf(MESSAGE_STYLE_LABEL));
    expect(p.indexOf(MESSAGE_STYLE_LABEL)).toBeLessThan(p.indexOf(STYLE));
  });

  it("a change applies to the next agent call of a running worker, with no restart", async () => {
    const { store } = await newStore();
    const settings = live(store);
    const w = worker(store, { settings });
    await settings.refresh();
    expect((await w.roleSpec("review")).system_prompt).toBe(prompts.review);
    await setStyle(store, STYLE);
    // What the worker does before each claim (Worker.tick): one refresh of the stored overrides.
    await settings.refresh();
    expect((await w.roleSpec("review")).system_prompt).toBe(withMessageStyle(prompts.review, STYLE));
    await setStyle(store, "");
    await settings.refresh();
    expect((await w.roleSpec("review")).system_prompt).toBe(prompts.review);
  });
});

/** Triage, approve, implement and review one item through the controller and a worker; the runner's specs per role. */
async function flow(style: string | null) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  if (style !== null) await setStyle(store, style);
  const source = new FakeSource();
  const runner = new FakeRunner({
    triage: () => ({ output: triageSpec }),
    implement: () => ({ output: { summary: "s", next_steps: "n" } }),
    review: () => ({ output: { verdict: "pass", tier: 2, findings: [], summary: "s" } }),
  });
  const controller = new ControllerRole({ store, source, forge: new FakeForge(source, []), auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner, repeated_failure_rule: false });
  const w = worker(store, { runner, clock, ...(style !== null ? { settings: live(store) } : {}) });
  const step = async () => {
    await controller.tickIntake();
    while (await w.tick()) await controller.tickRuns();
    await controller.tickRuns();
  };
  const src = issueRef(70);
  source.queue.push({ kind: "item_requested", source: src, requester: alice, title: "t", body: "b" });
  await step();
  source.queue.push({ kind: "spec_approved", source: src, comment_id: "300", approver: alice });
  await step();
  const spec = (role: string): AgentRunSpec => {
    const s = runner.specs.find((x) => x.role === role);
    if (!s) throw new Error(`no ${role} run`);
    return s;
  };
  return { spec, source };
}

describe("agent runs end to end", () => {
  it("triage and review runs carry the style once after their instructions; schemas, models and tools are unchanged", async () => {
    const styled = await flow(STYLE);
    const none = await flow(null);
    for (const role of ["triage", "implement", "review"]) {
      const s = styled.spec(role);
      const n = none.spec(role);
      expect(s.system_prompt, role).toBe(withMessageStyle(n.system_prompt, STYLE));
      expect(count(s.system_prompt, STYLE), role).toBe(1);
      expect(s.output_schema, role).toEqual(n.output_schema);
      expect(s.model_class, role).toBe(n.model_class);
      expect(s.tools, role).toEqual(n.tools);
      expect(s.tool_grants, role).toEqual(n.tool_grants);
      // The style reaches the system prompt only, never the run's own prompt.
      expect(s.prompt, role).not.toContain(STYLE);
    }
    // The factory's fixed templates (spec and review comments, command footers) never carry it.
    for (const c of styled.source.comments) expect(c.body).not.toContain(STYLE);
  });

  it("empty (the default): every run's system prompt, schema and prompt match a worker with no settings", async () => {
    const empty = await flow("");
    const none = await flow(null);
    for (const role of ["triage", "implement", "review"]) {
      const e = empty.spec(role);
      const n = none.spec(role);
      expect(e.system_prompt, role).toBe(n.system_prompt);
      expect(e.output_schema, role).toEqual(n.output_schema);
      expect(e.tools, role).toEqual(n.tools);
    }
  });
});

class RecordingLLM implements LLMProvider {
  requests: LLMRequest[] = [];
  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.requests.push(req);
    const parsed = { cause: "the flaky test", fix: "pin the port", touches: ["tests/x.test.ts"], needs_person: false };
    return { text: JSON.stringify(parsed), parsed, stop_reason: "end", usage: { input_tokens: 1, output_tokens: 1, cost_usd: null } };
  }
}

/** One improve run over two failed triage runs of the same code; the draft call's request. */
async function improveDraft(style: string | null): Promise<LLMRequest> {
  const clock = new FakeClock("2026-03-04T01:00:00.000Z");
  const { store } = await newStore(clock);
  if (style !== null) await setStyle(store, style);
  for (const n of [1, 2]) {
    clock.advance(1_000);
    await store.createWorkItem(issue(n), system, { enqueue: { kind: "triage", idempotency_key: `t${n}` } });
    const run = (await store.claimRun({ worker_id: "seed" as WorkerId, kinds: ["triage"], lease_ms: 60_000 }))!;
    await store.completeRun(run.id as RunId, run.lease!.token, { status: "failed", error_code: "same", detail: "d", infra: false });
  }
  clock.set("2026-03-05T06:00:00.000Z");
  await enqueueImprove({ store, clock }, PROJECT.key, "daily");
  const llm = new RecordingLLM();
  const w = worker(store, { llm, clock, prompts: { ...prompts, improve: "IMPROVE DRAFT\n" }, ...(style !== null ? { settings: live(store) } : {}) });
  expect(await w.tick()).toBe(true);
  expect(llm.requests).toHaveLength(1);
  return llm.requests[0]!;
}

describe("improve drafts", () => {
  it("set: the draft's system prompt is the improve instructions, then the style once; the schema is unchanged", async () => {
    const styled = await improveDraft(STYLE);
    const none = await improveDraft(null);
    expect(styled.system).toBe(withMessageStyle(improvePrompts("IMPROVE DRAFT\n").draft, STYLE));
    expect(count(styled.system!, STYLE)).toBe(1);
    expect(styled.output_schema).toEqual(none.output_schema);
    expect(styled.messages).toEqual(none.messages);
  });

  it("empty: the draft request is the one with no settings", async () => {
    const empty = await improveDraft("");
    const none = await improveDraft(null);
    expect(empty.system).toBe(none.system);
    expect(empty.system).toBe(improvePrompts("IMPROVE DRAFT\n").draft);
    expect(empty.output_schema).toEqual(none.output_schema);
  });
});

describe("chat answers (interpret)", () => {
  it("the request's system prompt is the rules, then the style once; the user message and schema are unchanged", async () => {
    const { store } = await newStore();
    const { item } = await store.createWorkItem(issue(5), system);
    const items = openItems([item]);
    for (const at of ["top_level", { item: items[0]!, blocked_reason: null }] as const) {
      const plain = interpretRequest("how is it going?", items, at);
      const styled = interpretRequest("how is it going?", items, at, STYLE);
      expect(styled.system).toBe(withMessageStyle(plain.system!, STYLE));
      expect(count(styled.system!, STYLE)).toBe(1);
      expect(styled.system!.indexOf(STYLE)).toBeGreaterThan(styled.system!.indexOf("Answer only with JSON"));
      expect(styled.messages).toEqual(plain.messages);
      expect(styled.output_schema).toEqual(plain.output_schema);
      expect(styled.model_class).toBe(plain.model_class);
      // Empty: byte-identical to the request with no style.
      expect(interpretRequest("how is it going?", items, at, "")).toEqual(plain);
    }
    // A command footer is a fixed template: it never carries the style.
    expect(commandFooter({ phase: "spec_pending", stage: "READY" } as never)).not.toContain(STYLE);
  });
});
