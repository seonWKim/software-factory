import { describe, expect, it } from "vitest";
import { testPathsOnly } from "../src/core/auto-grant.js";
import { AUTO_GRANT, autoGrants } from "../src/controller/units/run-results/auto-grant.js";
import { GATE_PATHS } from "../src/core/improver.js";
import { LiveSettings, SETTABLE_DEFAULTS, baseFromConfig } from "../src/core/settings.js";
import type { Run, WorkerId, WorkItem } from "../src/core/types.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { Worker } from "../src/worker/index.js";
import { conflictAsk } from "../src/worker/runs/implement/conflict-ask.js";
import { failingTestFiles } from "../src/core/checks.js";
import { NEEDS_HUMAN_MAX_CHARS, NEEDS_HUMAN_MAX_PATHS } from "../src/core/outputs.js";
import { isCovered } from "../src/core/policy.js";
import { newStore } from "./helpers/store.js";
import {
  FakeAuth, FakeBroker, FakeForge, FakeRunner, FakeSandbox, FakeSource, MemoryStorage, alice, config, issueRef, prompts, recordingLog, silent, triageSpec,
} from "./helpers/fakes.js";

// An implement run's needs-human ask for test paths only is granted once without the owner (design 05-restarts,
// 2026-11-15): the owner's `/retry +paths` transition, applied by the controller with the system actor.

/** The default test_globs, as the settings catalog gives them. */
const DEFAULT_TEST_GLOBS = SETTABLE_DEFAULTS.test_globs as string[];
const TESTS = ["tests/ui-link-style.test.tsx", "tests/ui-thread.test.tsx"];
/** A ratchet list: always covered, whatever allowed_paths says (isCovered). */
const RATCHET = "tests/architecture/known-violations/no-clock.json";
const askFor = (paths: readonly string[]) => ({ output: { needs_human: { reason: "A test outside the allowed paths breaks.", question: "Allow it?", paths } } });
const done = { output: { summary: "s", next_steps: "n" } };
const pass = { output: { verdict: "pass", tier: 2, findings: [], summary: "s" } };

async function factory(implement: (n: number) => object) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const source = new FakeSource();
  const broker = new FakeBroker();
  const scanner = new PatternEgressScanner(async () => []);
  const log = recordingLog();
  let calls = 0;
  const runner = new FakeRunner({ triage: () => ({ output: triageSpec }), implement: () => implement(++calls), review: () => pass });
  /** A controller process on the shared store: a restart or another worker builds a new one. */
  const controller = () => new ControllerRole({
    store, source, forge: new FakeForge(null, broker.calls), auth: new FakeAuth(), clock, config, log, scanner,
    settings: new LiveSettings({ config, base: baseFromConfig(config), source: store }),
  });
  let c = controller();
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox: new FakeSandbox(), runner, broker, storage: new MemoryStorage(), clock, config, prompts, log: silent, scanner,
    toolEnv: { PATH: "/usr/bin" }, awake: new NoKeepAwake(),
  });
  const step = async () => {
    await c.tickIntake();
    while (await worker.tick()) await c.tickRuns();
    await c.tickRuns();
  };
  const src = issueRef(1);
  const item = async () => (await store.getWorkItemBySource("github_issue", src.id))!;
  /** Through triage to the spec's `/approve`: the implement run is queued, not run yet. */
  const approve = async (): Promise<WorkItem> => {
    source.queue.push({ kind: "item_requested", source: src, requester: alice, title: "t", body: "b" });
    await step();
    source.queue.push({ kind: "spec_approved", source: src, comment_id: "9001", approver: alice });
    await c.tickIntake();
    return item();
  };
  const runs = async (kind: Run["kind"]) => (await store.listRuns((await item()).id)).filter((r) => r.kind === kind);
  const changes = async () => store.listStateChanges((await item()).id);
  const grants = async () => (await changes()).filter((ch) => ch.reason === "retry_requested");
  const comments = (key: string) => source.comments.filter((m) => m.marker.startsWith(`<!-- factory:${key}:`));
  const bodies = () => source.comments.map((m) => m.body);
  return {
    store, log, step, approve, item, runs, changes, grants, comments, bodies, worker, controller,
    get c() { return c; },
    restart: () => { c = controller(); },
    calls: () => calls,
  };
}

describe("testPathsOnly", () => {
  it("is true when every path matches a test glob and none is on the gate list, CLAUDE.md or AGENTS.md", () => {
    expect(testPathsOnly(TESTS, DEFAULT_TEST_GLOBS)).toBe(true);
    expect(testPathsOnly(["src/ui/thread.test.tsx"], DEFAULT_TEST_GLOBS)).toBe(true);
    expect(testPathsOnly(["src/ui/thread.tsx", ...TESTS], DEFAULT_TEST_GLOBS)).toBe(false);
    expect(testPathsOnly([], DEFAULT_TEST_GLOBS)).toBe(false);
    for (const p of ["tests/architecture/settings-monotonic.test.ts", "prompts/review.test.md", "tests/CLAUDE.md", "tests/AGENTS.md", "CLAUDE.md", "AGENTS.md"]) {
      expect(testPathsOnly([p], [...DEFAULT_TEST_GLOBS, "*.md"]), p).toBe(false);
    }
    expect(testPathsOnly(TESTS, ["**/*.test.ts"])).toBe(false);
  });

  it("leaves GATE_PATHS as it was: CLAUDE.md and AGENTS.md are refused by this check only", () => {
    expect(GATE_PATHS).not.toContain("CLAUDE.md");
    expect(GATE_PATHS).not.toContain("AGENTS.md");
  });

  it("counts only the retries marked as automatic grants", () => {
    const rows = [
      { reason: "retry_requested", detail: { [AUTO_GRANT]: true } },
      { reason: "retry_requested", detail: null },
      { reason: "agent_needs_human", detail: { [AUTO_GRANT]: true } },
    ];
    expect(autoGrants(rows)).toEqual([rows[0]]);
  });
});

describe("an implement run that asks only for test paths", () => {
  it("leads to one system /retry +paths with those paths: the item does not wait on the owner", async () => {
    const f = await factory((n) => (n === 1 ? askFor(TESTS) : done));
    await f.approve();
    await f.step();
    const grants = await f.grants();
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ actor: { kind: "system", id: "system:controller" }, detail: { added_paths: JSON.stringify(TESTS), [AUTO_GRANT]: true } });
    expect(String(grants[0]!.detail!.note)).toContain("granted automatically because the ask named test paths only");
    expect((await f.item()).allowed_paths).toEqual([...triageSpec.allowed_paths, ...TESTS]);
    expect(await f.runs("implement")).toHaveLength(2);
    expect((await f.changes()).map((ch) => ch.reason)).not.toContain("agent_needs_human");
    expect(f.comments("needs-human")).toEqual([]);
    expect(await f.item()).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending" });
  });

  it("names the granted paths in the thread comment and the run log, and says they were granted automatically", async () => {
    const f = await factory((n) => (n === 1 ? askFor(TESTS) : done));
    await f.approve();
    await f.step();
    const [comment] = f.comments("auto-grant");
    expect(comment!.body).toContain(`/retry +paths ${TESTS.join(" ")}`);
    expect(comment!.body).toContain("Granted automatically because the ask named test paths only");
    for (const p of TESTS) expect(comment!.body).toContain(`\`${p}\``);
    const line = f.log.lines.find((l) => l.msg.includes("granted automatically because the ask named test paths only"));
    expect(line?.fields).toMatchObject({ paths: TESTS.join(" ") });
  });

  it("a request with a non-test path or a gate-list path posts the owner comment and blocks on the human as before", async () => {
    for (const paths of [["src/ui/thread.tsx", TESTS[0]!], ["tests/architecture/settings-monotonic.test.ts"], ["prompts/review.test.md"], ["tests/CLAUDE.md"], ["tests/AGENTS.md"]]) {
      const f = await factory(() => askFor(paths));
      await f.approve();
      await f.step();
      expect(await f.item(), paths.join(" ")).toMatchObject({ blocked_on: "human", blocked_reason: "agent_needs_human" });
      expect(await f.grants(), paths.join(" ")).toEqual([]);
      expect(f.comments("needs-human"), paths.join(" ")).toHaveLength(1);
      expect(f.comments("needs-human")[0]!.body).toContain(`/retry +paths ${paths.join(" ")}`);
      expect(f.comments("auto-grant")).toEqual([]);
    }
  });

  it("a second request on the same item, after an automatic grant, blocks on the human as before", async () => {
    const f = await factory((n) => (n === 1 ? askFor(TESTS) : askFor(["tests/ui-shortcuts.test.tsx"])));
    await f.approve();
    await f.step();
    expect(await f.grants()).toHaveLength(1);
    expect(await f.item()).toMatchObject({ blocked_on: "human", blocked_reason: "agent_needs_human" });
    expect(f.comments("needs-human")).toHaveLength(1);
    expect(f.comments("needs-human")[0]!.body).toContain("/retry +paths tests/ui-shortcuts.test.tsx");
    expect(await f.runs("implement")).toHaveLength(2);
  });

  it("two workers handling the same request produce one retry; the second is refused by the version fence and queues no second run", async () => {
    const f = await factory((n) => (n === 1 ? askFor(TESTS) : done));
    const before = await f.approve();
    expect(await f.worker.tick()).toBe(true);
    const [run] = await f.runs("implement");
    expect(run).toMatchObject({ status: "succeeded", acknowledged_at: null });
    const other = f.controller();
    await Promise.all([f.c.applyRun(run!), other.applyRun(run!)]);
    expect(await f.grants()).toHaveLength(1);
    expect((await f.runs("implement")).filter((r) => r.status === "queued")).toHaveLength(1);
    expect((await f.item()).version).toBe(before.version + 1);
    expect(f.comments("auto-grant")).toHaveLength(1);
    expect(f.comments("needs-human")).toEqual([]);
    // Applied once more (a later tick on either worker): the grant is stored, so nothing changes.
    await other.applyRun({ ...run!, acknowledged_at: null });
    expect((await f.item()).version).toBe(before.version + 1);
  });

  it("counts a covered-path requeue as the item's one automatic action: a later test-path ask waits for the owner", async () => {
    const f = await factory((n) => (n === 1 ? askFor([RATCHET]) : askFor(TESTS)));
    await f.approve();
    await f.step();
    expect(await f.grants()).toHaveLength(1);
    expect(await f.item()).toMatchObject({ blocked_on: "human", blocked_reason: "agent_needs_human", allowed_paths: triageSpec.allowed_paths });
    expect(f.comments("needs-human")[0]!.body).toContain(`/retry +paths ${TESTS.join(" ")}`);
  });

  it("counts the grant from stored state changes: a new controller on the same store does not repeat it", async () => {
    const f = await factory((n) => (n === 1 ? askFor(TESTS) : askFor(TESTS)));
    await f.approve();
    expect(await f.worker.tick()).toBe(true);
    await f.c.tickRuns();
    expect(await f.grants()).toHaveLength(1);
    f.restart();
    await f.step();
    expect(f.calls()).toBe(2);
    expect(await f.grants()).toHaveLength(1);
    expect(await f.item()).toMatchObject({ blocked_on: "human", blocked_reason: "agent_needs_human" });
    expect(f.comments("needs-human")).toHaveLength(1);
  });
});

// A conflict resolution whose checks failed only on test files outside allowed_paths ends in the sync step's ask
// (design 05-merge-conflict, 2026-11-18): the same once-only grant applies to it.
describe("an implement run whose conflict resolution failed only on out-of-scope test files", () => {
  const conflictFor = (files: readonly string[]) => {
    const tail = files.map((f) => ` FAIL  ${f} > keeps a`).join("\n");
    const rules = {
      failingTestFiles, covered: (p: string) => isCovered(p, triageSpec.allowed_paths), grantable: (ps: readonly string[]) => testPathsOnly(ps, DEFAULT_TEST_GLOBS),
      maxPaths: NEEDS_HUMAN_MAX_PATHS, maxChars: NEEDS_HUMAN_MAX_CHARS,
    };
    return { output: { needs_human: conflictAsk({ command: ["npm", "test"], how: "exited 1", tail }, rules) } };
  };

  it("runs again once with the files granted; a second such ask waits for the owner", async () => {
    const f = await factory((n) => conflictFor(n === 1 ? TESTS : ["tests/ui-shortcuts.test.tsx"]));
    await f.approve();
    await f.step();
    const grants = await f.grants();
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ actor: { kind: "system", id: "system:controller" }, detail: { added_paths: JSON.stringify(TESTS), [AUTO_GRANT]: true } });
    expect(await f.runs("implement")).toHaveLength(2);
    expect(f.comments("auto-grant")).toHaveLength(1);
    expect(await f.item()).toMatchObject({ blocked_on: "human", blocked_reason: "agent_needs_human", allowed_paths: [...triageSpec.allowed_paths, ...TESTS] });
    expect(f.comments("needs-human")).toHaveLength(1);
    expect(f.comments("needs-human")[0]!.body).toContain("/retry +paths tests/ui-shortcuts.test.tsx");
  });
});

// An implement run's needs-human ask that names only paths the factory already allows (design 05-restarts,
// 2026-11-16): a ratchet list, or a path under allowed_paths. Requeued by the controller, no person asked.
describe("an implement run that asks only for paths already allowed", () => {
  it("is requeued once with the system actor: no hold, no owner comment asking for /retry", async () => {
    const f = await factory((n) => (n === 1 ? askFor([RATCHET]) : done));
    await f.approve();
    await f.step();
    const grants = await f.grants();
    expect(grants).toHaveLength(1);
    expect(grants[0]!.actor).toEqual({ kind: "system", id: "system:controller" });
    expect(String(grants[0]!.detail!.note)).toContain(`already allowed: ${RATCHET}`);
    expect((await f.changes()).map((ch) => ch.reason)).not.toContain("agent_needs_human");
    expect(f.comments("needs-human")).toEqual([]);
    expect(f.bodies().every((b) => !b.includes("/retry +paths"))).toBe(true);
    expect(await f.runs("implement")).toHaveLength(2);
    expect(await f.item()).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending" });
  });

  it("changes no allowed_paths and records the stopped run and the automatic marker", async () => {
    const f = await factory((n) => (n === 1 ? askFor([RATCHET, triageSpec.files_to_change[0]!]) : done));
    await f.approve();
    await f.step();
    const [first] = await f.runs("implement");
    const [grant] = await f.grants();
    expect(grant!.detail).toMatchObject({ run_id: first!.id, [AUTO_GRANT]: true });
    expect(grant!.detail!.added_paths).toBeUndefined();
    expect(grant!.changes.allowed_paths).toBeUndefined();
    expect((await f.item()).allowed_paths).toEqual(triageSpec.allowed_paths);
    expect(f.comments("auto-grant")[0]!.body).toContain(`already allowed: ${RATCHET}`);
  });

  it("an ask that also names an uncovered non-test path goes to the owner, whose reply names only that path", async () => {
    const f = await factory(() => askFor([RATCHET, "src/loader.ts"]));
    await f.approve();
    await f.step();
    expect(await f.item()).toMatchObject({ blocked_on: "human", blocked_reason: "agent_needs_human" });
    expect(await f.grants()).toEqual([]);
    const [ask] = f.comments("needs-human");
    expect(ask!.body).toContain("```\n/retry +paths src/loader.ts\n```");
  });

  it("a second covered-only ask on the same item holds on agent_needs_human", async () => {
    const f = await factory(() => askFor([RATCHET]));
    await f.approve();
    await f.step();
    expect(await f.grants()).toHaveLength(1);
    expect(await f.item()).toMatchObject({ blocked_on: "human", blocked_reason: "agent_needs_human" });
    expect(f.comments("needs-human")).toHaveLength(1);
    expect(await f.runs("implement")).toHaveLength(2);
  });

  it("follows auto_grant_test_paths: switched off, globally or for the project, the ask waits for the owner", async () => {
    for (const project of ["", config.project.key]) {
      const f = await factory(() => askFor([RATCHET]));
      if (project) await f.store.setSettingOverride({ key: "auto_grant_test_paths", project: "", value: "true", actor: "local:owner" });
      await f.store.setSettingOverride({ key: "auto_grant_test_paths", project, value: "false", actor: "local:owner" });
      await f.approve();
      await f.step();
      expect(await f.grants(), project).toEqual([]);
      expect(await f.item(), project).toMatchObject({ blocked_on: "human", blocked_reason: "agent_needs_human" });
      expect(f.comments("needs-human"), project).toHaveLength(1);
    }
  });
});
