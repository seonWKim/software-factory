import { describe, expect, it } from "vitest";
import { NO_FILES_REFUSAL, RECHECK_PATHS_REFUSAL, parseComment, refusalText } from "../src/core/commands.js";
import { RECHECK_AFTER_MS } from "../src/controller/units/commands/premise-recheck.js";
import { githubCommand } from "../src/core/command-inbox.js";
import { runLocalCli } from "../src/core/local-cli.js";
import { parseTriage } from "../src/core/outputs.js";
import type { UserId, WorkItem } from "../src/core/types.js";
import { HealthMonitor } from "../src/ui/health.js";
import { type UiDeps, respond } from "../src/ui/server.js";
import { newCsrfToken } from "../src/ui/settings-api.js";
import { alice, cleanScanner, settingsWith, triageSpec } from "./helpers/fakes/config.js";
import { pipeline } from "./helpers/harness.js";
import { answersDetail, splitAnswers } from "../src/shared/command-notes.js";

// A spec's premise (design 04-spec-gate-commands, 2026-11-20): a spec whose files_to_change is empty changes no file
// in this repo, so no surface approves it; a /retry on an item whose last change is over a day old re-checks the
// premise with a triage run first.

const NO_FILES = { ...triageSpec, files_to_change: [] as string[] };
const DAY = RECHECK_AFTER_MS;

/** The pipeline with every spec waiting at the gate (spec_gate_min_tier 1), triage answering `spec`. */
async function gate(spec: Record<string, unknown> = NO_FILES, opts: Parameters<typeof pipeline>[0] = {}) {
  const f = await pipeline({ ...opts, config: { dials: { spec_gate_min_tier: 1, auto_merge_max_tier: 0 }, ...opts.config } });
  f.runner.script.triage = () => ({ output: spec });
  let comments = 0;
  /** A GitHub comment `body` by alice on `it`'s issue, through the command inbox; then one controller pass. */
  const comment = async (it: WorkItem, body: string) => {
    const parsed = parseComment(body);
    if (parsed?.kind !== "command") throw new Error(body);
    await f.store.appendCliCommand(githubCommand({ comment_id: 800 + ++comments, user_id: 1, command: parsed.name, text: parsed.text, source: it.source }));
    await f.controller.tickCommands();
  };
  const refusals = (it: WorkItem) => f.source.comments.filter((c) => c.source.id === it.source.id && c.marker.startsWith("<!-- factory:refused:"));
  /** What a refused command must leave as it was. */
  const shape = async (it: WorkItem) => {
    const x = await f.item(it);
    return {
      stage: x.stage, blocked_on: x.blocked_on, blocked_reason: x.blocked_reason, allowed_paths: x.allowed_paths, tier: x.tier, version: x.version,
      runs: (await f.runs(it)).map((r) => ({ kind: r.kind, key: r.idempotency_key, status: r.status })),
    };
  };
  return { ...f, comment, refusals, shape };
}

describe("a spec that changes no file in this repo", () => {
  it("parseTriage still accepts an empty files_to_change, and the stored spec keeps the empty list", async () => {
    const parsed = parseTriage(NO_FILES);
    expect(parsed.ok && parsed.value.files_to_change).toEqual([]);
    const f = await gate();
    const it0 = await f.submit();
    await f.step();
    expect(await f.item(it0)).toMatchObject({ stage: "READY", blocked_reason: "spec_pending", files_to_change: [] });
  });

  it("its spec comment says it changes no file here and names /revise and /reject; the footer has no /approve", async () => {
    const f = await gate();
    const it0 = await f.submit();
    await f.step();
    const spec = f.source.comments.find((c) => c.marker.includes("spec:"))!.body;
    expect(spec).toContain(`This spec cannot be approved: ${NO_FILES_REFUSAL}.`);
    expect(spec).toContain("changes no file in this repo");
    const footer = spec.slice(spec.indexOf("Commands you can reply with now:"));
    expect(footer).toContain("`/revise <feedback>`");
    expect(footer).toContain("`/reject <reason>`");
    expect(footer).not.toContain("/approve");
    expect((await f.item(it0)).blocked_reason).toBe("spec_pending");
  });

  it("a spec that changes a file keeps /approve in its footer and no such line", async () => {
    const f = await gate(triageSpec);
    await f.submit();
    await f.step();
    const spec = f.source.comments.find((c) => c.marker.includes("spec:"))!.body;
    expect(spec).not.toContain(NO_FILES_REFUSAL);
    expect(spec.slice(spec.indexOf("Commands you can reply with now:"))).toContain("`/approve [notes]`");
  });

  it("a /approve comment is refused with one reply; stage, block, runs, allowed_paths and tier are unchanged", async () => {
    const f = await gate();
    const it0 = await f.submit();
    await f.step();
    const before = await f.shape(it0);
    await f.comment(it0, "/approve");
    await f.comment(it0, "/approve +paths docs/x.md");
    expect(await f.shape(it0)).toEqual(before);
    expect(f.refusals(it0).map((c) => c.body)).toEqual([refusalText("/approve", NO_FILES_REFUSAL), refusalText("/approve", NO_FILES_REFUSAL)]);
    // The same event delivered by a poll: still refused, still nothing changed.
    await f.controller.handleEvent({ kind: "spec_approved", source: it0.source, comment_id: "c9", approver: alice });
    expect(await f.shape(it0)).toEqual(before);
  });

  it("a stored approve command (`factory approve`) is refused the same way", async () => {
    const f = await gate();
    const it0 = await f.submit();
    await f.step();
    const before = await f.shape(it0);
    const cli = { answers: { split: splitAnswers, detail: answersDetail }, store: f.store, identity: { user: "1" as UserId, from: "cli_user" as const }, project: async () => it0.project, read: async () => "", newId: () => "n1" };
    // `factory approve`'s own check reads the item's fields only, so it stores the command for the controller (FakeAuth reads the local user `1` as github:1).
    expect((await runLocalCli(cli, { action: "command", command: "approve", id: it0.id, text: "" })).code).toBe(0);
    await f.controller.tickCommands();
    expect(await f.shape(it0)).toEqual(before);
    expect(f.refusals(it0).map((c) => c.body)).toEqual([refusalText("/approve", NO_FILES_REFUSAL)]);
  });

  it("the dashboard's approve is refused while the request is handled, with the same text, and nothing changes", async () => {
    const f = await gate();
    const it0 = await f.submit();
    await f.step();
    const before = await f.shape(it0);
    const HOST = "127.0.0.1:4310";
    const token = newCsrfToken();
    const d: UiDeps = {
      store: f.store, scanner: cleanScanner, clock: f.clock, lease_ms: 60_000, health: new HealthMonitor(async () => [], f.clock),
      commands: { actor: "github:1" as UserId, source: "config", token, allowed: async () => ({ allow: true }) },
    };
    const r = await respond(d, {
      method: "POST", url: `/api/v1/items/${encodeURIComponent(it0.id)}/commands`, host: HOST, origin: `http://${HOST}`,
      contentType: "application/json", csrfToken: token, body: JSON.stringify({ command: "approve" }),
    });
    expect(r.status).toBe(202);
    const body = JSON.parse(r.body) as { outcome: string; refusal: string };
    expect(body.outcome).toBe("refused");
    expect(body.refusal).toBe(refusalText("/approve", NO_FILES_REFUSAL));
    await f.controller.tickCommands();
    expect(await f.shape(it0)).toEqual(before);
  });
});

describe("/retry on an item whose last change is over a day old", () => {
  /** An item whose implement run failed and blocked on a human (max_attempts 1). */
  async function failed() {
    const f = await gate(triageSpec, { config: { settings: settingsWith({ max_attempts: 1 }) } });
    f.runner.script.implement = () => ({ status: "failed", error: "boom" });
    const it0 = await f.submit();
    await f.step();
    await f.comment(it0, "/approve");
    await f.step();
    const blocked = await f.item(it0);
    expect(blocked).toMatchObject({ stage: "RUNNING", blocked_on: "human" });
    expect(blocked.blocked_reason).toBe("max_attempts");
    return { f, it0: blocked };
  }

  it("re-checks the premise: one retry_requested change to NEW with the block cleared, and one triage run under a new key, no implement run", async () => {
    const { f, it0 } = await failed();
    const keys = new Set((await f.runs(it0)).map((r) => r.idempotency_key));
    f.clock.advance(DAY + 1);
    await f.comment(it0, "/retry");
    const after = await f.item(it0);
    expect(after).toMatchObject({ stage: "NEW", blocked_on: "none", blocked_reason: null, restart_count: it0.restart_count + 1 });
    const changes = (await f.store.listStateChanges(it0.id)).filter((c) => c.version > it0.version);
    expect(changes.map((c) => c.reason)).toEqual(["retry_requested"]);
    expect(changes[0]!.detail).toMatchObject({ premise_recheck: true, previous_blocked_reason: it0.blocked_reason });
    const queued = (await f.runs(it0)).filter((r) => r.status === "queued");
    expect(queued.map((r) => r.kind)).toEqual(["triage"]);
    expect(keys.has(queued[0]!.idempotency_key)).toBe(false);
    expect(f.refusals(it0)).toEqual([]);
  });

  it("then waits at the spec gate, and /approve queues the implement run under a new key", async () => {
    const { f, it0 } = await failed();
    const implementKeys = new Set((await f.runs(it0, "implement")).map((r) => r.idempotency_key));
    f.clock.advance(DAY + 1);
    await f.comment(it0, "/retry");
    f.runner.script.implement = () => ({ output: { summary: "s", next_steps: "n" } });
    // Only the triage run: the item waits at the gate.
    expect(await f.w1.tick()).toBe(true);
    await f.controller.tickRuns();
    expect(await f.item(it0)).toMatchObject({ stage: "READY", blocked_on: "human", blocked_reason: "spec_pending" });
    await f.comment(it0, "/approve");
    const implement = (await f.runs(it0, "implement")).filter((r) => r.status === "queued");
    expect(implement).toHaveLength(1);
    expect(implementKeys.has(implement[0]!.idempotency_key)).toBe(false);
  });

  it("at exactly a day old it retries as before: the implement run again, no triage", async () => {
    const { f, it0 } = await failed();
    f.clock.advance(DAY);
    await f.comment(it0, "/retry");
    expect(await f.item(it0)).toMatchObject({ stage: "RUNNING", blocked_on: "none", restart_count: it0.restart_count + 1 });
    expect((await f.runs(it0)).filter((r) => r.status === "queued").map((r) => r.kind)).toEqual(["implement"]);
  });

  it("with +paths it is refused with one reply, and nothing changes", async () => {
    const { f, it0 } = await failed();
    const before = await f.shape(it0);
    f.clock.advance(DAY + 1);
    await f.comment(it0, "/retry +paths docs/x.md");
    expect(await f.shape(it0)).toEqual(before);
    expect(f.refusals(it0).map((c) => c.body)).toEqual([refusalText("/retry", RECHECK_PATHS_REFUSAL)]);
  });

  it("at the review loop limit it resets loop_count to 0", async () => {
    const f = await gate(triageSpec);
    const it0 = await f.submit();
    await f.step();
    const at = await f.item(it0);
    const r = await f.store.transition({
      id: at.id, expected_version: at.version, actor: { kind: "system", id: "system:test" }, reason: "setup",
      patch: { stage: "REVIEW", blocked_on: "human", blocked_reason: "max_loops", loop_count: 3, change_ref: "9" },
    });
    if (!r.ok) throw new Error("setup");
    f.clock.advance(DAY + 1);
    await f.comment(it0, "/retry");
    expect(await f.item(it0)).toMatchObject({ stage: "NEW", blocked_on: "none", blocked_reason: null, loop_count: 0, restart_count: at.restart_count + 1 });
    expect((await f.runs(it0)).filter((x) => x.status === "queued").map((x) => x.kind)).toEqual(["triage"]);
  });
});
