import { beforeAll, describe, expect, it } from "vitest";
import { COMMANDS, COMMAND_PHASES, type CommandName, type CommandPhase, applies, commandFooter, commandPhase, commandState, phaseLabel } from "../src/core/commands.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import type { WorkItemPatch } from "../src/core/types.js";
import type { SourceEvent } from "../src/interfaces/source-adapter.js";
import { retry } from "../src/controller/units/support.js";
import { runKindLabel } from "../src/controller/units/run-results/run-kind-label.js";
import { FakeAuth } from "./helpers/fakes/runner.js";
import { FakeSource } from "./helpers/fakes/source.js";
import { alice, cleanScanner, config, issueRef, silent } from "./helpers/fakes/config.js";
import { newStore, PROJECT_KEY, system, w1 } from "./helpers/store.js";

describe("footers match what the controller accepts", () => {
  /** A patch that puts an item in each phase; floor_tier also needs its floor_blocked row, rule_of_two its held run. */
  const PATCHES: Record<CommandPhase, WorkItemPatch> = {
    triaging: {},
    spec_pending: { stage: "READY", blocked_on: "human", blocked_reason: "spec_pending" },
    budget_checkpoint: { stage: "RUNNING", blocked_on: "budget", blocked_reason: "budget_checkpoint" },
    max_revisions: { stage: "READY", blocked_on: "human", blocked_reason: "max_revisions" },
    implementing: { stage: "RUNNING" },
    dependency_hold: { stage: "RUNNING", blocked_on: "dependency", blocked_reason: "waiting for #1 to merge" },
    dependency_closed: { stage: "RUNNING", blocked_on: "human", blocked_reason: "dependency_closed:#1" },
    phase_hold: { stage: "NEW", blocked_on: "upstream", blocked_reason: "phase_hold" },
    floor_tier: { stage: "RUNNING", blocked_on: "human", blocked_reason: "floor_tier" },
    rule_of_two: { stage: "RUNNING", blocked_on: "human", blocked_reason: "rule_of_two" },
    failed_review: { stage: "REVIEW", blocked_on: "human", blocked_reason: "max_attempts" },
    failed_run: { stage: "REVIEW", blocked_on: "human", blocked_reason: "run_failed:update:invalid_output" },
    too_large: { stage: "RUNNING", blocked_on: "human", blocked_reason: "run_failed:implement:diff_too_large" },
    failed_implement: { stage: "RUNNING", blocked_on: "human", blocked_reason: "max_attempts" },
    agent_needs_human: { stage: "RUNNING", blocked_on: "human", blocked_reason: "agent_needs_human" },
    repeated_failure: { stage: "RUNNING", blocked_on: "human", blocked_reason: "repeated_failure" },
    recurring_failure: { stage: "RUNNING", blocked_on: "human", blocked_reason: "recurring_failure" },
    reviewing: { stage: "REVIEW" },
    merge_pending: { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending" },
    max_loops: { stage: "REVIEW", blocked_on: "human", blocked_reason: "max_loops" },
    merge_conflict: { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_conflict_pending" },
    session_released: { stage: "RUNNING", blocked_on: "human", blocked_reason: "session_released" },
    other_blocked: { stage: "RUNNING", blocked_on: "ci", blocked_reason: "something" },
    merged: { stage: "CLOSED", close_reason: "completed", merge_sha: "m1" },
    closed: { stage: "CLOSED", close_reason: "rejected" },
  };
  const ACTING: CommandName[] = ["approve", "reject", "revise", "retry", "budget", "verdict"];

  function event(name: CommandName, n: number): SourceEvent {
    const base = { source: issueRef(n), comment_id: String(n) };
    switch (name) {
      case "approve": return { kind: "spec_approved", ...base, approver: alice, note: "" };
      case "reject": return { kind: "spec_rejected", ...base, approver: alice, reason: "no" };
      case "revise": return { kind: "revise_requested", ...base, requester: alice, feedback: "more" };
      case "retry": return { kind: "retry_requested", ...base, requester: alice };
      case "budget": return { kind: "budget_continue", ...base, approver: alice, amount: null };
      default: return { kind: "verdict_submitted", target: { kind: "issue", source: issueRef(n) }, ...base, approver: alice, args: "accept none" };
    }
  }

  async function harness() {
    const { store, clock } = await newStore();
    const source = new FakeSource();
    const controller = new ControllerRole({ store, source, auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner });
    const actor = { kind: "system" as const, id: "test" };
    /** A new work item on issue `n`, put in `phase`, with or without a PR. */
    const itemIn = async (phase: CommandPhase, pr: number | null, n: number) => {
      const { item } = await store.createWorkItem({ source: issueRef(n), requester_id: "github:1" as never, project: PROJECT_KEY, problem: "p", resources: [] }, actor);
      const setup = {
        id: item.id, expected_version: item.version, actor, reason: phase === "floor_tier" ? "floor_blocked" : "setup",
        patch: { ...PATCHES[phase], change_ref: pr === null ? null : String(pr), tier: 2 as const },
        ...(phase === "floor_tier" ? { detail: { required_tier: 3 } } : {}),
        ...(phase === "rule_of_two" ? { detail: { held_by: "rule_of_two", held_run_kind: "implement", held_run_key: `held:${n}` } } : {}),
      };
      // A budget checkpoint is a block plus its pending checkpoint row, which /budget and /reject answer.
      const r = phase === "budget_checkpoint"
        ? await store.openBudgetCheckpoint({
            ...setup,
            reason: "budget_checkpoint",
            checkpoint: {
              tier: 2, tokens_spent: 2_000, budget: 1_000, suggested_budget: 3_000,
              held_run_kind: "implement", held_run_key: `held:${n}`, held_run_not_before: null,
            },
          })
        : await store.transition(setup);
      if (!r.ok) throw new Error("setup failed");
      return r.item;
    };
    return { store, source, controller, itemIn };
  }
  type Harness = Awaited<ReturnType<typeof harness>>;

  /** The issue part of a footer: the PR block (if any) comes before it. */
  const issuePart = (footer: string) => footer.slice(footer.indexOf("Commands you can reply with now:"));

  // One test per phase on one shared harness: all phases in one test drove 264 controller events and took over 5 s
  // under full-suite load. Every phase makes its own items on its own issue numbers, so no phase sees another's.
  describe("for every phase, with and without a PR, a command is refused exactly when the footer leaves it out", () => {
    let h: Harness;
    beforeAll(async () => { h = await harness(); });

    COMMAND_PHASES.forEach((phase, i) => it(phase, async () => {
      const { source, controller, itemIn } = h;
      let n = 1 + i * 20;
      for (const pr of [null, 42]) {
        const state = { phase, has_pr: pr !== null };
        const footer = commandFooter(state);
        for (const name of ACTING) {
          n++;
          const item = await itemIn(phase, pr, n);
          expect(commandPhase(item)).toBe(phase);
          expect(commandState(item)).toEqual(state);
          await controller.handleEvent(event(name, n));
          const refused = source.comments.some((c) => c.marker === `<!-- factory:refused:${n} -->`);
          const spec = COMMANDS.find((c) => c.name === name)!;
          // At too_large /approve is listed, but the over-cap check refuses it without the blocked run's size and a note,
          // which this item has neither of ("/approve over the cap at too_large" covers both).
          const overCap = phase === "too_large" && name === "approve";
          expect({ phase, pr, name, accepted: !refused }).toEqual({ phase, pr, name, accepted: applies(spec, state) && !overCap });
          expect({ phase, pr, name, listed: issuePart(footer).includes(`\`${spec.usage}\``) }).toEqual({ phase, pr, name, listed: !refused || overCap });
        }
      }
    }));
  });

  it("for every phase, a /revise on the item's PR is refused exactly when the footer's PR block leaves it out", async () => {
    const { store, source, controller, itemIn } = await harness();
    let n = 20_000;
    for (const phase of COMMAND_PHASES) {
      n++;
      const item = await itemIn(phase, 42, n);
      const state = commandState(item);
      await controller.handleEvent({
        kind: "revise_requested", source: issueRef(42), comment_id: String(n), requester: alice, feedback: "fix the flag",
        pr: { change_ref: "42", head_branch: `${config.branch_prefix}${item.id}` },
      });
      const after = (await store.getWorkItem(item.id))!;
      const refused = source.comments.filter((c) => c.marker === `<!-- factory:refused:${n} -->`);
      const listed = commandFooter(state).startsWith("On the change") && commandFooter(state).includes("`/revise <feedback>`");
      if (phase === "closed" || phase === "merged") {
        // A closed item's PR, merged or not: no change and no reply.
        expect(refused).toEqual([]);
        expect(after).toEqual(item);
        continue;
      }
      expect({ phase, accepted: after.version !== item.version }).toEqual({ phase, accepted: listed });
      expect({ phase, refused: refused.length }).toEqual({ phase, refused: listed ? 0 : 1 });
      if (!listed) {
        expect(refused[0]!.source).toEqual(issueRef(42));
        expect(refused[0]!.body).toContain(`the item is ${phaseLabel(phase)}`);
      }
    }
  });

  it("/retry +paths on a failed review or update run is refused with one reply and nothing changes; on a failed implement run it widens", async () => {
    const { store, source, controller, itemIn } = await harness();
    let n = 30_000;
    for (const phase of ["failed_review", "failed_run", "failed_implement"] as const) {
      n++;
      const item = await itemIn(phase, phase === "failed_implement" ? null : 42, n);
      const e: SourceEvent = { kind: "retry_requested", source: issueRef(n), comment_id: String(n), requester: alice, note: "+paths src/a.ts" };
      await controller.handleEvent(e);
      // Refused twice: still one reply. (An applied /retry delivered again is refused as no failed run is left.)
      if (phase !== "failed_implement") await controller.handleEvent(e);
      const after = (await store.getWorkItem(item.id))!;
      const refused = source.comments.filter((c) => c.marker === `<!-- factory:refused:${n} -->`);
      if (phase === "failed_implement") {
        expect(refused).toEqual([]);
        expect(after.allowed_paths).toEqual([...item.allowed_paths, "src/a.ts"]);
        continue;
      }
      expect(after).toEqual(item);
      expect(refused).toHaveLength(1);
      expect(refused[0]!.body).toContain(`a ${phase === "failed_review" ? "Review" : "Update"} run`);
      expect(refused[0]!.body).toContain("applies only to a failed implement or resolve run");
    }
  });

  it("for a failed resolve run, retryKind is resolve and retry() widens allowed_paths and enqueues a resolve run", async () => {
    const { store, controller, itemIn } = await harness();
    const item0 = await itemIn("merge_conflict", 42, 31_000);
    const queued = await store.transition({
      id: item0.id, expected_version: item0.version, patch: {}, actor: system, reason: "setup", enqueue: { kind: "resolve", idempotency_key: "r31000" },
    });
    if (!queued.ok) throw new Error("setup failed");
    const run = (await store.claimRun({ worker_id: w1, kinds: ["resolve"], lease_ms: 60_000 }))!;
    await store.completeRun(run.id, run.lease!.token, { status: "failed", error_code: "boom", detail: "x", infra: false });
    const blocked = await store.transition({
      id: item0.id, expected_version: queued.item.version, actor: system, reason: "setup", patch: { stage: "REVIEW", blocked_on: "human", blocked_reason: "repeated_failure" },
    });
    if (!blocked.ok) throw new Error("setup failed");
    const item = blocked.item;
    const unit = await controller.unit("commands");
    expect(await unit.retryKind(item)).toBe("resolve");
    const d = retry(item, system, "resolve", "keep both imports", unit.widen(item, ["src/a.ts"]), runKindLabel);
    if (!d || "refuse" in d) throw new Error(d?.refuse ?? "no decision");
    expect(d.patch.allowed_paths).toEqual([...item.allowed_paths, "src/a.ts"]);
    expect(d.enqueue).toMatchObject({ kind: "resolve", input: { notes: "keep both imports" } });
  });

  // One test per phase on one shared harness, as above: all phases in one test drove 400 controller events.
  describe("no refusal, /help or unknown-command reply in any state names a raw stage; /help names the state by its label", () => {
    const RAW = /\b(NEW|READY|RUNNING|REVIEW|CLOSED)\b/;
    const isReply = (marker: string) => /^<!-- factory:(refused|help|unknown):/.test(marker);
    const extra = (n: number): SourceEvent[] => {
      const base = { source: issueRef(n), comment_id: String(n), requester: alice };
      // /resolve last: at a merge conflict it applies, and the two replies before it describe the state.
      return [
        { kind: "help_requested", ...base, comment_id: `${n}h` },
        { kind: "unknown_command", ...base, comment_id: `${n}u`, command: "xyz" },
        { kind: "resolve_requested", ...base, notes: "", pr: null },
      ];
    };
    let h: Harness;
    beforeAll(async () => { h = await harness(); });

    COMMAND_PHASES.forEach((phase, i) => it(phase, async () => {
      const { source, controller, itemIn } = h;
      const issues = new Set<string>();
      let n = 10_000 + i * 20;
      for (const pr of [null, 42]) {
        // One item per command, so each sees the state, not what an earlier command made of it.
        for (const make of [...ACTING.map((name) => (k: number) => [event(name, k)]), extra]) {
          n++;
          await itemIn(phase, pr, n);
          issues.add(issueRef(n).id);
          for (const e of make(n)) await controller.handleEvent(e);
        }
        const help = source.comments.find((c) => c.marker === `<!-- factory:help:${n}h -->`)!;
        expect(help.body).toContain(`(${phaseLabel(phase)})`);
      }
      for (const c of source.comments.filter((c) => isReply(c.marker) && issues.has(c.source.id))) {
        expect({ phase, body: c.body, raw: RAW.test(c.body) }).toMatchObject({ raw: false });
      }
    }));

    it("the phases above were refused often enough to test the refusals", () => {
      expect(h.source.comments.filter((c) => c.marker.startsWith("<!-- factory:refused:")).length).toBeGreaterThan(50);
    });
  });
});
