// The harness (RFC 0023 R4): what wires the controller, the worker or the plugin REGISTRY over the fakes. Only a
// test that runs the whole loop or a registry imports it; a fake never does (tests/architecture/test-helper-reach.test.ts).
import type { FactoryConfig } from "../../src/core/config.js";
import type { Run, WorkItem, WorkerId } from "../../src/core/types.js";
import type { AgentRunResult, AgentRunSpec } from "../../src/interfaces/agent-runner.js";
import type { EgressScanner } from "../../src/interfaces/egress-scanner.js";
import type { NetworkProbe } from "../../src/interfaces/network-probe.js";
import { REGISTRY, type Registry, withPlugin } from "../../src/plugins.js";
import { ControllerRole } from "../../src/runtime/roles/controller-role.js";
import { Worker } from "../../src/worker/index.js";
import { NoKeepAwake } from "../../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../../src/impl/clock/fake-clock.js";
import { newStore } from "./store.js";
import { FakeBroker } from "./fakes/broker.js";
import { alice, cleanScanner, config, issueRef, prompts, recordingLog, triageSpec } from "./fakes/config.js";
import { FakeForge } from "./fakes/forge.js";
import { FakeAuth, FakeRunner, FakeSandbox, MemoryStorage } from "./fakes/runner.js";
import { FakeSlackPollSource, FakeSource, FakeStreamSource } from "./fakes/source.js";

/** REGISTRY plus the test-only `fake-slack-poll` source. */
export function fakeSlackPollRegistry(base: Registry = REGISTRY, make: () => FakeSlackPollSource = () => new FakeSlackPollSource()): Registry {
  return withPlugin(base, "source", "fake-slack-poll", make);
}

/** REGISTRY plus the test-only `fake-stream` source. The only place fake-stream is wired. */
export function fakeStreamRegistry(base: Registry = REGISTRY, make: () => FakeStreamSource = () => new FakeStreamSource()): Registry {
  return withPlugin(base, "source", "fake-stream", make);
}

/**
 * The whole loop on fakes: a controller and two workers sharing one store, sandbox, broker and runner. Specs are
 * auto-approved (spec_gate_min_tier 3, triageSpec is tier 2), so implement and review follow triage at once.
 */
export async function pipeline(opts: {
  implement?: (spec: AgentRunSpec) => Partial<AgentRunResult> | Promise<Partial<AgentRunResult>>;
  config?: Partial<FactoryConfig>;
  scanner?: EgressScanner;
  /** The controller's network probe (design §5 Restarts); absent: none, so a network pause ends at its probe time. */
  network_probe?: NetworkProbe;
} = {}) {
  const cfg: FactoryConfig = { ...config, dials: { spec_gate_min_tier: 3, auto_merge_max_tier: 0 }, ...opts.config };
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const source = new FakeSource();
  const sandbox = new FakeSandbox();
  const broker = new FakeBroker();
  const forge = new FakeForge(source, broker.calls);
  const runner = new FakeRunner({
    triage: () => ({ output: triageSpec }),
    implement: opts.implement ?? (() => ({ output: { summary: "the summary", next_steps: "the next steps" } })),
    review: () => ({ output: { verdict: "pass", tier: 2, findings: [], summary: "s" } }),
  });
  const log = recordingLog();
  const scanner = opts.scanner ?? cleanScanner;
  const controller = new ControllerRole({
    store, source, forge, auth: new FakeAuth(), clock, config: cfg, log, scanner, repeated_failure_rule: false,
    ...(opts.network_probe ? { network_probe: opts.network_probe } : {}),
  });
  const worker = (id: string) =>
    new Worker({
      id: id as WorkerId, store, sandbox, runner, broker, storage: new MemoryStorage(),
      clock, config: cfg, prompts, log, scanner, toolEnv: {}, awake: new NoKeepAwake(), prRef: (pr) => forge.prRef(pr),
    });
  const w1 = worker("w1");
  const w2 = worker("w2");
  let n = 0;
  const submit = async () => {
    n++;
    source.queue.push({ kind: "item_requested", source: issueRef(n), requester: alice, title: "t", body: "b" });
    await controller.tickIntake();
    return (await store.getWorkItemBySource("github_issue", issueRef(n).id))!;
  };
  /** Workers take what they may claim now; the controller applies every outcome. */
  const step = async () => {
    while ((await w1.tick()) || (await w2.tick())) await controller.tickRuns();
    await controller.tickRuns();
  };
  const item = async (it: WorkItem) => (await store.getWorkItem(it.id))!;
  const runs = async (it: WorkItem, kind?: Run["kind"]) => (await store.listRuns(it.id)).filter((r) => !kind || r.kind === kind);
  const agentCalls = (role: AgentRunSpec["role"]) => runner.specs.filter((s) => s.role === role).length;
  return { config: cfg, clock, store, source, forge, sandbox, broker, runner, log, controller, w1, w2, submit, step, item, runs, agentCalls };
}
