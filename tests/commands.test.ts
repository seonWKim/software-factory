import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import {
  COMMANDS, COMMAND_PHASES, type CommandName, type CommandPhase, applies, appliesOnPr, approveRefusal, chatHelpReply, commandFooter, commandPhase, commandSpec,
  commandState, commandsFor, commandTableMarkdown, helpReply, parseCommandPaths, parseComment, phaseLabel, prCommandsFor, refusalText, retryPathsReply,
  unknownCommandReply, withSlash,
} from "../src/core/commands.js";
import { autoApprovedFooter, utcMinute } from "../src/core/spec-comment.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { COMMAND_TABLE, cliHelpLine, cliUsageOf } from "../src/core/command-table.js";
import type { SourceRef, UserId, WorkItem, WorkItemId, WorkItemPatch } from "../src/core/types.js";
import { runLocalCli } from "../src/core/local-cli.js";
import { githubCommand } from "../src/core/command-inbox.js";
import type { AuthProvider } from "../src/interfaces/auth-provider.js";
import type { SourceEvent } from "../src/interfaces/source-adapter.js";
import { storedAnswers } from "../src/shared/command-notes.js";
import { FakeAuth, FakeSlackPollSource, FakeSource, alice, cleanScanner, config, issueRef, pipeline, silent, slackRef, triageSpec } from "./helpers/fakes.js";
import { newStore, PROJECT_KEY, system, w1 } from "./helpers/store.js";

describe("parseComment", () => {
  const cmd = (name: CommandName, text = "") => ({ kind: "command", name, text });

  it("reads /approve with no note, a same-line note, and a note on the lines below", () => {
    expect(parseComment("/approve")).toEqual(cmd("approve"));
    expect(parseComment("/approve keep it small")).toEqual(cmd("approve", "keep it small"));
    expect(parseComment("/approve\nkeep it small\nand tested")).toEqual(cmd("approve", "keep it small\nand tested"));
    expect(parseComment("/approve first\r\nsecond  \n\n")).toEqual(cmd("approve", "first\nsecond"));
    expect(parseComment("  /approve   \n")).toEqual(cmd("approve"));
  });

  it("matches names case-insensitively and accepts punctuation after the word", () => {
    expect(parseComment("/APPROVE")).toEqual(cmd("approve"));
    expect(parseComment("/Approve. thanks")).toEqual(cmd("approve", "thanks"));
    expect(parseComment("/retry!")).toEqual(cmd("retry"));
    expect(parseComment("/reject: too big")).toEqual(cmd("reject", "too big"));
    expect(parseComment("/help?")).toEqual(cmd("help"));
  });

  it("an unknown word is an unknown command, as typed", () => {
    expect(parseComment("/aprove")).toEqual({ kind: "unknown", word: "aprove" });
    expect(parseComment("/rejectfoo no")).toEqual({ kind: "unknown", word: "rejectfoo" });
    expect(parseComment("/Xyz")).toEqual({ kind: "unknown", word: "Xyz" });
  });

  it("anything that is not `/` plus letters and a boundary is not a command", () => {
    for (const body of ["looks good", "", "/", "/ approve", "/ ", "/src/core/x.ts is wrong", "/approve2", "/re-ject", "x /approve", "/123"]) {
      expect(parseComment(body)).toBeNull();
    }
  });

  it("/reject and /revise keep the rest of the first line and the lines below", () => {
    expect(parseComment("/reject too big\nsplit it")).toEqual(cmd("reject", "too big\nsplit it"));
    expect(parseComment("/revise   \n")).toEqual(cmd("revise"));
  });
});

describe("+paths (issue #280)", () => {
  it("splits +paths and its paths off the first line; the lines below are the note", () => {
    expect(parseCommandPaths("+paths src/a.ts docs/b.md\nkeep it small\nand tested")).toEqual({ paths: ["src/a.ts", "docs/b.md"], note: "keep it small\nand tested" });
    expect(parseCommandPaths("+paths `src/a.ts` ./src/a.ts src/dir/")).toEqual({ paths: ["src/a.ts", "src/dir/"], note: "" });
    expect(parseCommandPaths("keep it small")).toEqual({ paths: [], note: "keep it small" });
    expect(parseCommandPaths("")).toEqual({ paths: [], note: "" });
    // Not the flag: a word that only starts with it, or the flag later in the text.
    expect(parseCommandPaths("+pathsx a")).toEqual({ paths: [], note: "+pathsx a" });
    expect(parseCommandPaths("see +paths a")).toEqual({ paths: [], note: "see +paths a" });
  });

  it("refuses no path, an empty, absolute, `..` or glob path, and more than 10", () => {
    for (const text of ["+paths", "+paths \nnote", "+paths ``", "+paths ./", "+paths /etc/x", "+paths ~/x", "+paths C:/x", "+paths a/../b",
      "+paths ..", "+paths src/*.ts", "+paths src/a?.ts", "+paths src/{a,b}.ts", "+paths src/[ab].ts",
      `+paths ${Array.from({ length: 11 }, (_, i) => `f${i}`).join(" ")}`]) {
      expect({ text, refused: "refuse" in parseCommandPaths(text) }).toEqual({ text, refused: true });
    }
    expect(parseCommandPaths(`+paths ${Array.from({ length: 10 }, (_, i) => `f${i}`).join(" ")}`)).toMatchObject({ paths: expect.any(Array) });
  });

  it("the /retry +paths reply is exact, parses back to the same paths, and is null when no single reply can allow them", () => {
    const reply = retryPathsReply(["src/a.ts", "docs/b.md", "src/a.ts"])!;
    expect(reply).toBe("/retry +paths src/a.ts docs/b.md");
    const parsed = parseComment(reply);
    expect(parsed).toMatchObject({ kind: "command", name: "retry" });
    expect(parseCommandPaths(parsed!.kind === "command" ? parsed!.text : "")).toEqual({ paths: ["src/a.ts", "docs/b.md"], note: "" });
    expect(retryPathsReply([])).toBeNull();
    expect(retryPathsReply(["a b.ts"])).toBeNull();
    expect(retryPathsReply(["src/*.ts"])).toBeNull();
    expect(retryPathsReply(Array.from({ length: 11 }, (_, i) => `f${i}`))).toBeNull();
  });

  it("/help and the command table show the +paths usage of /approve, /retry and /resolve", () => {
    const help = helpReply({ phase: "spec_pending", has_pr: false });
    for (const usage of ["`/approve +paths <path>...`", "`/retry +paths <path>...`", "`/resolve +paths <path>...`"]) {
      expect(help).toContain(usage);
      expect(commandTableMarkdown()).toContain(usage);
    }
    // The usage column stays `/resolve [notes]`; `+paths` is in its description, as for /retry.
    expect(helpReply({ phase: "merge_conflict", has_pr: true })).toContain("`/resolve [notes]` **(now)**");
  });
});

describe("command table", () => {
  const s = (phase: CommandPhase, has_pr = false) => ({ phase, has_pr });

  it("every command has a usage starting with its name and a one-line description", () => {
    for (const c of COMMANDS) {
      expect(c.usage.startsWith(`/${c.name}`)).toBe(true);
      expect(c.description).not.toContain("\n");
      expect(c.description.length).toBeGreaterThan(0);
    }
  });

  it("the spec footer lists /approve [notes], /reject <reason> and ends with /help", () => {
    const f = commandFooter(s("spec_pending")).split("\n");
    expect(f.some((l) => l.startsWith("- `/approve [notes]`"))).toBe(true);
    expect(f.some((l) => l.startsWith("- `/reject <reason>`"))).toBe(true);
    expect(f.at(-1)).toMatch(/^- `\/help`/);
  });

  it("a footer with no state-changing command ends with /help and a no-change line", () => {
    const f = commandFooter(s("merge_pending", true)).split("\n");
    expect(f.at(-2)).toMatch(/^- `\/help`/);
    expect(f.at(-1)).toBe("No command changes this item's state now.");
  });

  it("an unknown-command reply names the word, then the footer", () => {
    const r = unknownCommandReply("xyz", s("failed_run"));
    expect(r.split("\n")[0]).toBe('Unknown command "/xyz".');
    expect(r).toContain("`/retry`");
    expect(r.trim().split("\n").at(-1)).toMatch(/^- `\/help`/);
  });

  it("the /help reply lists every command and marks the ones that apply", () => {
    const r = helpReply(s("spec_pending"));
    for (const c of COMMANDS) expect(r).toContain(`\`${c.usage}\``);
    expect(r).toContain("`/approve [notes]` **(now)**");
    expect(r).toContain("`/retry`:");
    expect(r).not.toContain("`/retry` **(now)**");
    const cli = r.split("\n").filter((l) => l.includes("`factory task "));
    expect(cli).toEqual([cliHelpLine()]);
    for (const c of COMMAND_TABLE) expect(cli[0]).toContain(`\`factory ${cliUsageOf(c)}\``);
  });

  it("a failed implement run has its own phases: too_large for diff_too_large, failed_implement for any other failure", () => {
    const at = (stage: "NEW" | "RUNNING" | "REVIEW", blocked_reason: string) =>
      commandPhase({ stage, blocked_on: "human", blocked_reason, change_ref: null });
    expect(at("RUNNING", "run_failed:implement:diff_too_large")).toBe("too_large");
    expect(at("RUNNING", "run_failed:implement:no_commits")).toBe("failed_implement");
    expect(at("RUNNING", "max_attempts")).toBe("failed_implement");
    expect(at("RUNNING", "max_restart")).toBe("failed_implement");
    expect(at("NEW", "max_attempts")).toBe("failed_run");
    expect(at("NEW", "run_failed:triage:invalid_output")).toBe("failed_run");
    expect(at("REVIEW", "max_restart")).toBe("failed_review");
    expect(at("REVIEW", "run_failed:review:invalid_output")).toBe("failed_review");
    expect(at("REVIEW", "run_failed:update:invalid_output")).toBe("failed_run");
  });

  it("/revise has a PR meaning at a merge wait and a failed review run, only with a PR; the footer names it first", () => {
    const revise = commandSpec("revise");
    for (const phase of COMMAND_PHASES) {
      const on = phase === "merge_pending" || phase === "failed_review";
      expect({ phase, on: appliesOnPr(revise, s(phase, true)) }).toEqual({ phase, on });
      expect(appliesOnPr(revise, s(phase, false))).toBe(false);
      // Only /revise has a PR meaning.
      expect(prCommandsFor(s(phase, true)).map((c) => c.name)).toEqual(on ? ["revise"] : []);
    }
    const f = commandFooter(s("merge_pending", true)).split("\n");
    expect(f[0]).toBe("On the change, you can reply with:");
    expect(f[1]).toMatch(/^- `\/revise <feedback>`: On the PR: send your feedback to the implementer/);
    expect(f.indexOf("Commands you can reply with now:")).toBe(3);
    expect(commandFooter(s("merge_pending", false))).not.toContain("On the change");
    expect(commandFooter(s("reviewing", true))).not.toContain("/revise");
    expect(helpReply(s("failed_review", true))).toContain("`/revise <feedback>` **(now, on the PR)**: Get a new spec written with your feedback. On the PR:");
    expect(helpReply(s("failed_review", true))).toContain("(blocked by a failed review run)");
    expect(commandTableMarkdown()).toContain("; on its PR: waiting for a human merge, blocked by a failed review run |");
  });

  it("/revise and /retry apply at both failed-implement phases; /revise not at a failed triage, review or update run", () => {
    const names = (phase: CommandPhase) => commandsFor(s(phase)).map((c) => c.name);
    for (const phase of ["too_large", "failed_implement"] as const) {
      expect(names(phase)).toEqual(expect.arrayContaining(["revise", "retry", "reject"]));
      expect(commandFooter(s(phase))).toContain("`/revise <feedback>`");
    }
    expect(names("failed_run")).toContain("retry");
    expect(names("failed_run")).not.toContain("revise");
    expect(names("failed_review")).toContain("retry");
    expect(names("failed_review")).not.toContain("revise");
    expect(names("floor_tier")).not.toContain("revise");
    expect(phaseLabel("too_large")).toBe("blocked: the change was too large");
    expect(phaseLabel("failed_implement")).toBe("blocked by a failed implement run");
    expect(phaseLabel("failed_run")).toBe("blocked by a failed run");
    expect(phaseLabel("failed_review")).toBe("blocked by a failed review run");
  });

  it("agent_needs_human and repeated_failure take /retry, /revise and /reject; /resolve only after a resolve run asked", () => {
    const names = (phase: CommandPhase) => commandsFor(s(phase)).map((c) => c.name);
    for (const phase of ["agent_needs_human", "repeated_failure"] as const) {
      expect(names(phase)).toEqual(expect.arrayContaining(["retry", "revise", "reject"]));
      expect(names(phase)).not.toContain("resolve");
      for (const c of ["`/retry`", "`/revise <feedback>`", "`/reject <reason>`"]) expect(commandFooter(s(phase))).toContain(c);
    }
    expect(commandsFor({ phase: "agent_needs_human", has_pr: true, asked_by: "resolve" }).map((c) => c.name)).toContain("resolve");
    expect(commandsFor({ phase: "repeated_failure", has_pr: true, asked_by: "resolve" }).map((c) => c.name)).not.toContain("resolve");
    const at = (stage: "NEW" | "RUNNING" | "REVIEW", blocked_reason: string) =>
      commandPhase({ stage, blocked_on: "human", blocked_reason, change_ref: null });
    for (const stage of ["NEW", "RUNNING", "REVIEW"] as const) {
      expect(at(stage, "agent_needs_human")).toBe("agent_needs_human");
      expect(at(stage, "repeated_failure")).toBe("repeated_failure");
    }
    expect(phaseLabel("agent_needs_human")).toBe("blocked: the agent asked for a human");
    expect(phaseLabel("repeated_failure")).toBe("blocked: a run failed the same way twice");
  });

  it("/verdict needs a PR, except on a local item; a closed item takes none (issue #523)", () => {
    const verdict = commandSpec("verdict");
    const item = (type: string, change_ref: string | null) => ({
      stage: "REVIEW" as const, blocked_on: "human" as const, blocked_reason: "merge_pending", change_ref, source: { type, id: "x", link: "x" },
    });
    expect(applies(verdict, commandState(item("local", null)))).toBe(true);
    expect(applies(verdict, commandState(item("local", "42")))).toBe(true);
    for (const type of ["github_issue", "slack_thread"]) {
      expect(applies(verdict, commandState(item(type, null))), type).toBe(false);
      expect(applies(verdict, commandState(item(type, "42"))), type).toBe(true);
    }
    expect(applies(verdict, { phase: "closed", has_pr: false, local: true })).toBe(false);
    expect(applies(verdict, { phase: "merged", has_pr: false, local: true })).toBe(true);
    expect(commandTableMarkdown()).toContain("| any open or merged item, once it has a PR (a local item needs none) |");
  });

  it("/help names the state by its label, not its phase id", () => {
    expect(helpReply(s("spec_pending"))).toContain("(spec waiting for approval)");
    expect(helpReply(s("spec_pending"))).not.toContain("spec_pending");
    expect(helpReply(s("too_large"))).toContain("(blocked: the change was too large)");
    expect(helpReply(s("too_large"))).toContain("`/revise <feedback>` **(now)**");
    expect(helpReply(s("failed_implement"))).not.toContain("failed_implement");
  });

  it("SET_UP.md has the command table from code", () => {
    const setup = readFileSync(new URL("../SET_UP.md", import.meta.url), "utf8");
    expect(setup).toContain(commandTableMarkdown());
  });

  it("/help and the SET_UP.md table list every command in COMMANDS, /standing included, in table order", () => {
    const help = helpReply(s("spec_pending"));
    const table = commandTableMarkdown();
    const at = (text: string, usage: string) => text.indexOf(`\`${usage.replace(/\|/g, "\\|")}\``);
    for (const text of [help, table]) {
      const positions = COMMANDS.map((c) => (text === table ? at(text, c.usage) : text.indexOf(`\`${c.usage}\``)));
      expect(positions.every((p) => p >= 0)).toBe(true);
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    }
    expect(COMMANDS.map((c) => c.name)).toContain("standing");
    expect(help).toContain("`/standing [accept|decline <rule>]` **(now)**");
  });
});

describe("/standing", () => {
  const s = (phase: CommandPhase) => ({ phase, has_pr: false });

  it("is parsed with its arguments and becomes a standing_requested event", async () => {
    expect(parseComment("/standing accept spec-t1")).toEqual({ kind: "command", name: "standing", text: "accept spec-t1" });
    expect(parseComment("/standing")).toEqual({ kind: "command", name: "standing", text: "" });
    const { commentEvent } = await import("../src/core/comment-event.js");
    expect(commentEvent(issueRef(1), "9", alice, "/standing decline spec-t1")).toEqual({
      kind: "standing_requested", source: issueRef(1), comment_id: "9", requester: alice, args: "decline spec-t1",
    });
  });

  it("is never in an item's footer: it is about the factory's rules, not the item", () => {
    for (const phase of COMMAND_PHASES) expect(commandsFor(s(phase)).map((c) => c.name)).not.toContain("standing");
  });
});

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
          expect({ phase, pr, name, accepted: !refused }).toEqual({ phase, pr, name, accepted: applies(spec, state) });
          expect({ phase, pr, name, listed: issuePart(footer).includes(`\`${spec.usage}\``) }).toEqual({ phase, pr, name, listed: !refused });
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
      expect(refused[0]!.body).toContain(`a ${phase === "failed_review" ? "review" : "update"} run`);
    }
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

describe("answers to the spec's decisions on /approve (issue #526)", () => {
  const DECISIONS = [
    { question: "Fail the job, or only warn?", reason: "A failing job blocks merges.", options: ["Fail the job", "Only warn"], default: "Fail the job", owner_only: false },
    { question: "Name the step?", reason: "It shows in CI.", options: [], default: "scope", owner_only: false },
    { question: "Who owns the gate?", reason: "Someone answers its alerts.", options: [], default: "", owner_only: true },
  ];
  const NOTE = "1: Only warn\nkeep it small";
  const ANSWERS = [
    { question: "Fail the job, or only warn?", answer: "Only warn", accepted_default: false },
    { question: "Name the step?", answer: "scope", accepted_default: true },
    { question: "Who owns the gate?", answer: null, accepted_default: false },
  ];
  const ME = "local:me" as UserId;
  /** Lets everyone approve; the user ID is `provider:subject`, so a local identity is `local:<name>` as in solo. */
  const auth: AuthProvider = {
    resolve: async (i) => ({ user_id: `${i.provider}:${i.subject}` as UserId, attributes: {} }),
    authorize: async () => ({ allow: true }),
  };

  async function harness(judge: AuthProvider = auth) {
    const { store, clock } = await newStore();
    const source = new FakeSource();
    const controller = new ControllerRole({ store, sources: [source, new FakeSlackPollSource()], auth: judge, clock, config, log: silent, scanner: cleanScanner });
    /** A work item on `src` whose triage run wrote a spec with DECISIONS (or `decisions`), waiting for approval. */
    const triaged = async (src: SourceRef, decisions: unknown[] = DECISIONS): Promise<WorkItem> => {
      const { item } = await store.createWorkItem({ source: src, requester_id: "github:1" as UserId, project: PROJECT_KEY, problem: "p", resources: [] }, system);
      await store.enqueueRun({ work_item_id: item.id, kind: "triage", idempotency_key: `triage:${item.id}` });
      const run = (await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: 60_000 }))!;
      await store.completeRun(run.id, run.lease!.token, { status: "succeeded", summary: "s", data: { spec: { ...triageSpec, decisions } } });
      clock.advance(1000);
      await controller.tickRuns();
      const it = (await store.getWorkItem(item.id))!;
      expect(it).toMatchObject({ stage: "READY", blocked_reason: "spec_pending" });
      return it;
    };
    const approval = async (id: WorkItemId) => (await store.listStateChanges(id)).find((c) => c.reason === "spec_approved");
    let comments = 0;
    /** A GitHub comment on `it`'s issue by user `user`, as the issue source stores it: one command inbox row, then a controller tick. */
    const comment = async (it: WorkItem, body: string, user = 1) => {
      const parsed = parseComment(body);
      if (parsed?.kind !== "command") throw new Error(`not a command: ${body}`);
      await store.appendCliCommand(githubCommand({ comment_id: 900 + ++comments, user_id: user, command: parsed.name, text: parsed.text, source: it.source }));
      await controller.tickCommands();
    };
    return { store, source, controller, triaged, approval, comment };
  }

  it("a comment, a chat thread, the dashboard and the CLI go through the same parser and store the same answers", async () => {
    const h = await harness();
    const byComment = await h.triaged(issueRef(1));
    const bySlack = await h.triaged(slackRef(2));
    const byApp = await h.triaged(issueRef(3));
    const byCli = await h.triaged(issueRef(4));

    await h.controller.handleEvent({ kind: "spec_approved", source: byComment.source, comment_id: "c1", approver: alice, note: NOTE });
    await h.controller.handleEvent({ kind: "spec_approved", source: bySlack.source, comment_id: "s2", approver: { provider: "slack", subject: "U2", login: "u" }, note: NOTE });
    await h.store.recordAppCommandRequest({ key: "k3", actor: ME, command: "approve", args: { work_item_id: byApp.id, note: NOTE } });
    const cli = { store: h.store, identity: { user: ME, from: "git user.email" as const }, project: async () => PROJECT_KEY, read: async () => "", newId: () => "x" };
    expect((await runLocalCli(cli, { action: "command", command: "approve", id: byCli.id, text: NOTE })).code).toBe(0);
    await h.controller.tickCommands();

    const actors: Record<string, string> = {};
    for (const [name, it] of [["comment", byComment], ["slack", bySlack], ["app", byApp], ["cli", byCli]] as const) {
      const a = await h.approval(it.id);
      expect(a, name).toBeDefined();
      expect(storedAnswers(a!.detail), name).toEqual(ANSWERS);
      expect(a!.detail?.note, name).toBe("keep it small");
      actors[name] = a!.actor.id;
    }
    // The answer's actor is the approver's user ID: the local identity in solo, never a display name.
    expect(actors).toEqual({ comment: "github:1", slack: "slack:U2", app: ME, cli: ME });
  });

  it("a line naming no decision, a repeated N or an empty answer refuses the approval with one reply and stores nothing", async () => {
    const h = await harness();
    const cases = ["4: x", "1: a\n1: b", "2:  "];
    for (const [i, note] of cases.entries()) {
      const it = await h.triaged(issueRef(10 + i));
      await h.controller.handleEvent({ kind: "spec_approved", source: it.source, comment_id: `r${i}`, approver: alice, note });
      await h.controller.handleEvent({ kind: "spec_approved", source: it.source, comment_id: `r${i}`, approver: alice, note });
      expect(await h.approval(it.id)).toBeUndefined();
      expect(await h.store.getWorkItem(it.id)).toMatchObject({ stage: "READY", blocked_reason: "spec_pending" });
      const replies = (await h.store.listItemMessages(it.id)).filter((m) => m.marker === `<!-- factory:refused:r${i} -->`);
      expect(replies).toHaveLength(1);
      expect(replies[0]!.body).toContain("`/approve` was not applied");
    }
  });

  it("with no N: line every default is taken as accepted; a decision with no default stays unanswered and the approval goes ahead", async () => {
    const h = await harness();
    const it = await h.triaged(issueRef(20));
    await h.controller.handleEvent({ kind: "spec_approved", source: it.source, comment_id: "d1", approver: alice, note: "" });
    expect(await h.store.getWorkItem(it.id)).toMatchObject({ stage: "RUNNING" });
    expect(storedAnswers((await h.approval(it.id))!.detail)).toEqual([
      { question: "Fail the job, or only warn?", answer: "Fail the job", accepted_default: true },
      { question: "Name the step?", answer: "scope", accepted_default: true },
      { question: "Who owns the gate?", answer: null, accepted_default: false },
    ]);
  });

  it("a spec with no decisions keeps N: lines in the note and stores no answers", async () => {
    const h = await harness();
    const it = await h.triaged(issueRef(30), []);
    await h.controller.handleEvent({ kind: "spec_approved", source: it.source, comment_id: "n1", approver: alice, note: "1: not an answer" });
    const a = (await h.approval(it.id))!;
    expect(a.detail?.note).toBe("1: not an answer");
    expect(a.detail?.answers).toBeUndefined();
  });

  it("a GitHub comment /approve with N: lines stores the same answers as the dashboard approve (issue #527)", async () => {
    const h = await harness();
    const byComment = await h.triaged(issueRef(40));
    const byApp = await h.triaged(issueRef(41));
    await h.comment(byComment, `/approve\n${NOTE}`);
    await h.store.recordAppCommandRequest({ key: "k41", actor: ME, command: "approve", args: { work_item_id: byApp.id, note: NOTE } });
    await h.controller.tickCommands();
    const a = (await h.approval(byComment.id))!;
    expect(storedAnswers(a.detail)).toEqual(ANSWERS);
    expect(storedAnswers((await h.approval(byApp.id))!.detail)).toEqual(storedAnswers(a.detail));
    expect(a.detail?.note).toBe("keep it small");
    // The author is the stored user ID, never a login or display name.
    expect(a.actor).toEqual({ kind: "user", id: "github:1" });
  });

  it("a GitHub comment /revise with ### <Section> lines is stored with its text unchanged, and one with no heading too (issue #527)", async () => {
    const h = await harness();
    const structured = "### Problem\nSay why the gate is slow.\n\n### Allowed paths\nAlso `docs/`.";
    const items = [await h.triaged(issueRef(50)), await h.triaged(issueRef(51))];
    for (const [n, text] of [[0, structured], [1, "keep the existing CLI flag"]] as const) {
      const it = items[n]!;
      await h.comment(it, `/revise ${text}`);
      expect(await h.store.getWorkItem(it.id), `#${n}`).toMatchObject({ stage: "NEW", spec_feedback: text });
      const change = (await h.store.listStateChanges(it.id)).find((c) => c.reason === "spec_revision_requested");
      expect(change?.actor).toEqual({ kind: "user", id: "github:1" });
    }
  });

  it("a GitHub /approve with answers or a structured /revise by a user without the role is still refused, and nothing changes (issue #527)", async () => {
    const h = await harness(new FakeAuth());
    const it = await h.triaged(issueRef(60));
    await h.comment(it, `/approve\n${NOTE}`, 666);
    await h.comment(it, "/revise ### Problem\nnarrower", 666);
    expect(await h.store.getWorkItem(it.id)).toEqual(it);
    const replies = (await h.store.listItemMessages(it.id)).filter((m) => m.marker.startsWith("<!-- factory:refused:")).map((m) => m.body);
    expect(replies).toEqual([
      "`/approve` was not applied: it needs write permission on this repository (`not_a_collaborator`).",
      "`/revise` was not applied: it needs write permission on this repository (`not_a_collaborator`).",
    ]);
  });
});

describe("decisions for the spec in the implement and review prompts (issue #526)", () => {
  const decisions = [
    { question: "Fail the job, or only warn?", reason: "A failing job blocks merges.", options: ["Fail the job", "Only warn"], default: "Fail the job", owner_only: true },
  ];

  async function approved(spec: object, note: string) {
    const f = await pipeline({ config: { dials: { spec_gate_min_tier: 1, auto_merge_max_tier: 0 } } });
    f.runner.script.triage = () => ({ output: spec });
    const it = await f.submit();
    await f.step();
    expect(await f.item(it)).toMatchObject({ blocked_reason: "spec_pending" });
    await f.controller.handleEvent({ kind: "spec_approved", source: it.source, comment_id: "a1", approver: alice, note });
    await f.step();
    const prompt = (role: string) => f.runner.specs.find((s) => s.role === role)?.prompt ?? "";
    return { implement: prompt("implement"), review: prompt("review") };
  }

  it("both prompts carry the section, labelled untrusted and fenced, with each question, its answer and whether the default was taken", async () => {
    const p = await approved({ ...triageSpec, decisions }, "1: Only warn");
    for (const prompt of [p.implement, p.review]) {
      const at = prompt.indexOf("## Decisions for the spec");
      expect(at).toBeGreaterThan(-1);
      const section = prompt.slice(at);
      expect(section).toContain("Untrusted text");
      expect(section).toMatch(/```+text\n1\. Fail the job, or only warn\?\n {3}Answer: Only warn \(not the default\)\n```+/);
    }
  });

  it("the section is absent when the spec has no decisions", async () => {
    const p = await approved({ ...triageSpec, decisions: [] }, "1: a note");
    expect(p.implement).toContain("Notes from the approver");
    for (const prompt of [p.implement, p.review]) expect(prompt).not.toContain("Decisions for the spec");
  });
});

describe("one refusal and help text on every surface (issue #528)", () => {
  const ME = "github:1" as UserId;
  const auth: AuthProvider = { resolve: async (i) => ({ user_id: `${i.provider}:${i.subject}` as UserId, attributes: {} }), authorize: async () => ({ allow: true }) };

  async function harness() {
    const { store, clock } = await newStore();
    const source = new FakeSource();
    const controller = new ControllerRole({ store, sources: [source], auth, clock, config, log: silent, scanner: cleanScanner });
    let n = 0;
    /** A work item on its own issue, put in the state `patch` describes. */
    const itemIn = async (patch: WorkItemPatch): Promise<WorkItem> => {
      const { item } = await store.createWorkItem({ source: issueRef(++n), requester_id: ME, project: PROJECT_KEY, problem: "p", resources: [] }, system);
      if (Object.keys(patch).length === 0) return item;
      const r = await store.transition({ id: item.id, expected_version: item.version, actor: system, reason: "setup", patch: { tier: 2, ...patch } });
      if (!r.ok) throw new Error("setup");
      return r.item;
    };
    let comments = 0;
    /** A GitHub comment `body` on `it`'s issue; the controller's reply under `kind` (`refused`, `help`), or undefined. */
    const comment = async (it: WorkItem, body: string, kind: string) => {
      const parsed = parseComment(body);
      if (parsed?.kind !== "command") throw new Error(body);
      const id = 700 + ++comments;
      await store.appendCliCommand(githubCommand({ comment_id: id, user_id: 1, command: parsed.name, text: parsed.text, source: it.source }));
      await controller.tickCommands();
      return source.comments.find((c) => c.source.id === it.source.id && c.marker.startsWith(`<!-- factory:${kind}:`) && c.marker.includes(String(id)))?.body;
    };
    const cli = { store, identity: { user: ME, from: "cli_user" as const }, project: async () => PROJECT_KEY, read: async () => "", newId: () => `n${++comments}` };
    return { store, itemIn, comment, cli };
  }

  it("`factory approve` refuses with the controller's own text wherever approve does not apply, and stores nothing", async () => {
    const h = await harness();
    const STATES: [string, WorkItemPatch][] = [
      ["triaging", {}],
      ["reviewing", { stage: "REVIEW", change_ref: "9" }],
      ["merge_pending", { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", change_ref: "9" }],
      ["budget_checkpoint", { stage: "RUNNING", blocked_on: "human", blocked_reason: "budget_checkpoint" }],
      ["failed_implement", { stage: "RUNNING", blocked_on: "human", blocked_reason: "run_failed:implement:agent_error" }],
      ["max_loops", { stage: "REVIEW", blocked_on: "human", blocked_reason: "max_loops", change_ref: "9" }],
      ["dependency_hold", { stage: "RUNNING", blocked_on: "dependency", blocked_reason: "depends_on:o/r#1" }],
      ["closed", { stage: "CLOSED", close_reason: "rejected" }],
    ];
    for (const [name, patch] of STATES) {
      const it = await h.itemIn(patch);
      const reason = approveRefusal(it);
      expect(reason, name).not.toBeNull();
      const before = (await h.store.listCliCommandsAfter(0, 100)).length;
      const typed = await runLocalCli(h.cli, { action: "command", command: "approve", id: it.id, text: "" });
      expect({ name, typed }).toEqual({ name, typed: { code: 1, lines: [refusalText("/approve", reason!)] } });
      expect((await h.store.listCliCommandsAfter(0, 100)).length, name).toBe(before);
      expect({ name, reply: await h.comment(it, "/approve", "refused") }).toEqual({ name, reply: typed.lines[0] });
    }
  });

  it("approve is left to the controller at the spec gate, the floor block, the Rule of Two and a held implement run", () => {
    const states: Parameters<typeof approveRefusal>[0][] = [
      { stage: "READY", blocked_on: "human", blocked_reason: "spec_pending", change_ref: null },
      { stage: "READY", blocked_on: "human", blocked_reason: "max_revisions", change_ref: null },
      { stage: "RUNNING", blocked_on: "human", blocked_reason: "floor_tier", change_ref: null },
      { stage: "RUNNING", blocked_on: "human", blocked_reason: "rule_of_two", change_ref: null },
      { stage: "RUNNING", blocked_on: "none", blocked_reason: null, change_ref: null },
    ];
    for (const s of states) expect(approveRefusal(s), s.blocked_reason ?? "held").toBeNull();
  });

  it("`factory help <id>` prints the issue's /help reply for the item's state; `factory help` the same list with nothing marked", async () => {
    const h = await harness();
    for (const patch of [{}, { stage: "READY", blocked_on: "human", blocked_reason: "spec_pending" }, { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", change_ref: "9" }] as WorkItemPatch[]) {
      const it = await h.itemIn(patch);
      const typed = await runLocalCli(h.cli, { action: "help", id: it.id });
      expect(typed.code).toBe(0);
      expect(typed.lines.join("\n")).toBe(await h.comment(it, "/help", "help"));
    }
    const all = (await runLocalCli(h.cli, { action: "help", id: null })).lines.join("\n");
    expect(all).toBe(helpReply(null));
    for (const c of COMMANDS) expect(all).toContain(`- \`${c.usage}\`: ${c.description}`);
    expect(all).not.toContain("(now)");
  });

  it("chat help outside a thread: the reads, the request and /link; a bare word gets its slash only for approve", () => {
    const r = chatHelpReply(() => true, null);
    expect(r).toContain("`<request in plain words>`");
    expect(r).toContain(`- \`${commandSpec("link").usage}\`: ${commandSpec("link").description}.`);
    expect(r).not.toContain("with no slash");
    expect(withSlash("approve")).toBe("/approve");
    expect(withSlash("Approve ship it\nnow")).toBe("/Approve ship it\nnow");
    for (const t of ["approved it", "retry", "reject no", "please approve", "/approve"]) expect(withSlash(t), t).toBeNull();
  });
});

describe("the footer of a spec auto mode approved (issue #586)", () => {
  const AT = "2026-11-11T10:04:59.123Z";

  it("names the approval with its tier and time, then the commands after it, and never lists /approve", () => {
    for (const patch of [{ stage: "RUNNING" }, { stage: "RUNNING", blocked_on: "human", blocked_reason: "rule_of_two" }] as const) {
      const s = commandState({ blocked_on: "none", blocked_reason: null, change_ref: null, ...patch });
      const footer = autoApprovedFooter(s, 2, AT);
      expect(footer.split("\n")[0]).toBe("Approved automatically (auto mode, tier 2) at 2026-11-11 10:04 UTC.");
      expect(footer).toContain("Commands you can reply with now:");
      expect(footer).not.toContain("/approve");
      // The rest is the plain footer of that state, less /approve.
      for (const c of commandsFor(s).filter((c) => c.name !== "approve")) expect(footer).toContain(`\`${c.usage}\``);
    }
  });

  it("utcMinute reads an ISO time as its minute in UTC, and leaves other text as it is", () => {
    expect(utcMinute(AT)).toBe("2026-11-11 10:04 UTC");
    expect(utcMinute("soon")).toBe("soon");
  });
});
