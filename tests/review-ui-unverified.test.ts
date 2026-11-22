import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { localProject } from "../src/load-config.js";
import type { FactoryConfig } from "../src/core/config.js";
import { type CliAction, runLocalCli } from "../src/core/local-cli.js";
import { parseReview, REVIEW_SCHEMA, type ReviewOutput } from "../src/core/outputs.js";
import type { UserId, WorkerId, WorkItemId } from "../src/core/types.js";
import { OwnerAuth } from "../src/core/authorize.js";
import { LiveSettings, baseFromConfig } from "../src/core/settings.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { LocalToolBroker } from "../src/impl/broker/local-tool-broker.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { NoOpSandbox } from "../src/impl/sandbox/noop-sandbox.js";
import { LocalSource } from "../src/impl/source/local-source.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { Worker, reviewComment } from "../src/worker/index.js";
import { FakeRunner, MemoryStorage } from "./helpers/fakes/runner.js";
import { cleanScanner, config, prompts, silent, triageSpec } from "./helpers/fakes/config.js";
import { newStore } from "./helpers/store.js";
import { seedMergeRecord } from "./helpers/merge-record.js";

// A UI change the review could not check (design 04-agents, 2026-11-19): the reviewer sets `ui_unverified`, the
// review header reads "needs a human look", and auto mode never merges it; it waits for a person's merge. A review
// without the flag, and an older review stored before it, read and merge as before.

const ME = "local:me@example.com" as UserId;
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV }).trim();
const ident = ["-c", "user.name=t", "-c", "user.email=t@example.com"];
const OK = ["sh", "-c", "exit 0"];
const UNVERIFIED = ["could not run `npm run build`: no node_modules", "no screenshots at 1280px and 390px"];

const review = (extra: Partial<ReviewOutput> = {}): ReviewOutput => ({ verdict: "pass", tier: 2, findings: [], summary: "fine", ...extra });

describe("reviewComment: a UI change that could not be checked", () => {
  it("reads \"needs a human look\" with the flag, and lists what to look at under Not verified", () => {
    const body = reviewComment(review({ ui_unverified: true, unverified: UNVERIFIED }));
    expect(body).toMatch(/^## Factory review: needs a human look\n/);
    expect(body).not.toMatch(/Factory review: pass/);
    expect(body).toContain("### Not verified\n\n- could not run `npm run build`: no node_modules\n- no screenshots at 1280px and 390px");
  });

  it("keeps \"pass\" without the flag, even with unverified checks", () => {
    expect(reviewComment(review({ unverified: ["could not run the tests: listen EPERM"] }))).toMatch(/^## Factory review: pass\n/);
  });

  it("keeps \"changes needed\" for a bug verdict with the flag", () => {
    const body = reviewComment(review({ verdict: "bug", findings: [{ kind: "code", text: "x" }], ui_unverified: true }));
    expect(body).toMatch(/^## Factory review: changes needed\n/);
  });
});

describe("parseReview: ui_unverified", () => {
  it("keeps the flag when true, and the schema offers it as an optional boolean", () => {
    const r = parseReview({ ...review(), ui_unverified: true, unverified: UNVERIFIED });
    expect(r).toEqual({ ok: true, value: { ...review(), ui_unverified: true, unverified: UNVERIFIED } });
    expect(REVIEW_SCHEMA.properties).toHaveProperty("ui_unverified.type", "boolean");
    expect(REVIEW_SCHEMA.required).not.toContain("ui_unverified");
  });

  it("an older review without the field parses as before, and false is left out", () => {
    expect(parseReview({ verdict: "pass", tier: 3, findings: [], summary: "s" })).toEqual({ ok: true, value: { verdict: "pass", tier: 3, findings: [], summary: "s" } });
    expect(parseReview({ ...review(), ui_unverified: false })).toEqual({ ok: true, value: review() });
  });

  it("rejects a non-boolean flag", () => {
    expect(parseReview({ ...review(), ui_unverified: "yes" })).toEqual({ ok: false, error: "ui_unverified" });
  });
});

/** A local factory over a real git repo (as in auto-mode.test.ts) whose review answers `answer`. */
async function factory(answer: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), "sf-ui-unverified-"));
  const repo = join(root, "repo");
  git(root, "init", "--quiet", "-b", "main", repo);
  writeFileSync(join(repo, "README.md"), "hi\n");
  git(repo, "add", "-A");
  git(repo, ...ident, "commit", "--quiet", "-m", "init");
  git(repo, "checkout", "--quiet", "-b", "work");
  const project = localProject({ owner: "o", name: "r" });
  const file = String((triageSpec.files_to_change as string[])[0]);
  const cfg: FactoryConfig = { ...config, project, local_only: true, repo: { ...config.repo, path: repo, install_command: OK, test_command: OK } };
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  await seedMergeRecord(store, clock, { tier: 2 }); // a met record for the review's tier: only the flag holds the merge
  const sandbox = new NoOpSandbox(join(root, "wt"), undefined, undefined, { local: true });
  const settings = new LiveSettings({ config: cfg, base: baseFromConfig(cfg), source: store });
  const controller = new ControllerRole({
    store, sources: [new LocalSource(store)], auth: new OwnerAuth(store), clock, config: cfg, log: silent, scanner: cleanScanner,
    sandbox, repeated_failure_rule: false, settings, check_env: { PATH: process.env.PATH ?? "" },
  });
  const runner = new FakeRunner({
    triage: () => ({ output: triageSpec }),
    implement: (s) => {
      mkdirSync(join(s.sandbox.workdir, file, ".."), { recursive: true });
      writeFileSync(join(s.sandbox.workdir, file), "changed\n");
      git(s.sandbox.workdir, "add", "-A");
      git(s.sandbox.workdir, ...ident, "commit", "--quiet", "-m", "the change");
      return { output: { summary: "done", next_steps: "none" } };
    },
    review: () => ({ output: answer }),
  });
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox, runner, storage: new MemoryStorage(), clock, config: cfg, prompts, log: silent,
    broker: new LocalToolBroker({ store, scanner: cleanScanner, branchPrefix: cfg.branch_prefix, repoPath: repo }),
    scanner: cleanScanner, toolEnv: { PATH: process.env.PATH ?? "", HOME: root, GIT_CONFIG_GLOBAL: "/dev/null" }, awake: new NoKeepAwake(),
  });
  const step = async () => {
    await controller.tickIntake();
    while (await worker.tick()) await controller.tickRuns();
    await controller.tickRuns();
  };
  let n = 0;
  const cli = (a: CliAction) =>
    runLocalCli({ store, identity: { user: ME, from: "git user.email" }, project: async () => project.key, read: async () => "the body", newId: () => `id${++n}` }, a);
  const setting = (key: string, value: unknown) => store.setSettingOverride({ key, project: "", value: JSON.stringify(value), actor: ME });
  /** Created and approved in manual mode, reviewed to merge_pending, then auto mode is turned on and the factory steps. */
  const reviewedInAutoMode = async () => {
    const id = (await cli({ action: "create", title: "A change", bodyFile: "b.md" })).lines[0] as WorkItemId;
    await step();
    await cli({ action: "command", command: "approve", id, text: "" });
    await step();
    await step();
    expect(await store.getWorkItem(id)).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending" });
    await setting("auto_merge_max_tier", 3);
    await setting("mode", "auto");
    await step();
    await step();
    return id;
  };
  const messages = async (id: WorkItemId, prefix: string) => (await store.listItemMessages(id)).filter((m) => m.marker.startsWith(prefix)).map((m) => m.body);
  const merged = async (id: WorkItemId) => (await store.listStateChanges(id)).some((c) => c.reason === "local_merged");
  /** Queues one more review of the item and keeps it waiting for a merge; its head is unchanged, so it runs no agent. */
  const reviewAgain = async (id: WorkItemId, key: string) => {
    const cur = (await store.getWorkItem(id))!;
    const r = await store.transition({ id, expected_version: cur.version, patch: {}, actor: { kind: "system", id: "system:test" }, reason: "test_requeue", enqueue: { kind: "review", idempotency_key: key } });
    expect(r.ok).toBe(true);
    await step();
  };
  return { repo, store, step, cli, reviewedInAutoMode, reviewAgain, messages, merged };
}

describe("auto mode: the merge hold of a UI change that could not be checked", { timeout: 60_000 }, () => {
  it("with ui_unverified the item stays in merge_pending for a person, the reply says why, and a person's merge lands it", async () => {
    const f = await factory({ ...review(), ui_unverified: true, unverified: UNVERIFIED });
    const mainBefore = git(f.repo, "rev-parse", "main");
    const id = await f.reviewedInAutoMode();
    expect((await f.messages(id, "<!-- factory:review:")).join("")).toMatch(/^## Factory review: needs a human look/);
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending" });
    expect(await f.merged(id)).toBe(false);
    expect(git(f.repo, "rev-parse", "main")).toBe(mainBefore);
    const held = await f.messages(id, "<!-- factory:refused:");
    expect(held).toHaveLength(1);
    expect(held[0]).toContain("The automatic merge was not applied");
    expect(held[0]).toContain("`ui_unverified`");
    // A later step tries no second automatic merge.
    await f.step();
    expect(await f.messages(id, "<!-- factory:refused:")).toHaveLength(1);
    // A person's merge is not held.
    expect((await f.cli({ action: "command", command: "merge", id, text: "" })).code).toBe(0);
    await f.step();
    await f.step();
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "CLOSED", close_reason: "completed" });
  });

  it("a later review that skips an unchanged head keeps the hold: the flag comes from the latest verdict", async () => {
    const f = await factory({ ...review(), ui_unverified: true, unverified: UNVERIFIED });
    const mainBefore = git(f.repo, "rev-parse", "main");
    const id = await f.reviewedInAutoMode();
    await f.reviewAgain(id, "again-1");
    await f.step();
    const reviews = (await f.store.listRuns(id)).filter((r) => r.kind === "review");
    expect(reviews.map((r) => r.outcome?.status === "succeeded" && r.outcome.data.no_agent)).toEqual([undefined, "unchanged_head"]);
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending" });
    expect(await f.merged(id)).toBe(false);
    expect(git(f.repo, "rev-parse", "main")).toBe(mainBefore);
    const held = await f.messages(id, "<!-- factory:refused:");
    expect(held.length).toBeGreaterThan(0);
    expect(held.every((m) => m.includes("`ui_unverified`"))).toBe(true);
  });

  it("without the flag (an older review's shape) the review reads pass and auto mode merges it as before", async () => {
    const f = await factory({ verdict: "pass", tier: 2, findings: [], summary: "fine" });
    const id = await f.reviewedInAutoMode();
    expect((await f.messages(id, "<!-- factory:review:")).join("")).toMatch(/^## Factory review: pass/);
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "CLOSED", close_reason: "completed", merge_sha: git(f.repo, "rev-parse", "main") });
    expect(await f.merged(id)).toBe(true);
    expect(await f.messages(id, "<!-- factory:refused:")).toEqual([]);
  });
});
