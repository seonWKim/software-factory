import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  COMMANDS, COMMAND_PHASES, type CommandName, type CommandPhase, applies, appliesOnPr, commandFooter, commandPhase, commandSpec,
  commandState, commandsFor, commandTableMarkdown, helpReply, parseCommandPaths, parseComment, phaseLabel, prCommandsFor, retryPathsReply,
  unknownCommandReply,
} from "../src/core/commands.js";
import { Controller } from "../src/core/controller.js";
import { CLI_COMMANDS, cliHelpLine } from "../src/core/local-cli.js";
import type { WorkItemPatch } from "../src/core/types.js";
import type { SourceEvent } from "../src/interfaces/source-adapter.js";
import { FakeAuth, FakeSource, alice, cleanScanner, config, issueRef, silent } from "./helpers/fakes.js";
import { newStore, PROJECT_KEY } from "./helpers/store.js";

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

  it("/help and the command table show the +paths usage of /approve and /retry", () => {
    const help = helpReply({ phase: "spec_pending", has_pr: false });
    expect(help).toContain("`/approve +paths <path>...`");
    expect(help).toContain("`/retry +paths <path>...`");
    expect(commandTableMarkdown()).toContain("`/approve +paths <path>...`");
    expect(commandTableMarkdown()).toContain("`/retry +paths <path>...`");
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
    for (const c of CLI_COMMANDS) expect(cli[0]).toContain(`\`factory ${c.usage}\``);
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
  /** A patch that puts an item in each phase; floor_tier also needs its floor_blocked row. */
  const PATCHES: Record<CommandPhase, WorkItemPatch> = {
    triaging: {},
    spec_pending: { stage: "READY", blocked_on: "human", blocked_reason: "spec_pending" },
    budget_checkpoint: { stage: "RUNNING", blocked_on: "budget", blocked_reason: "budget_checkpoint" },
    max_revisions: { stage: "READY", blocked_on: "human", blocked_reason: "max_revisions" },
    implementing: { stage: "RUNNING" },
    dependency_hold: { stage: "RUNNING", blocked_on: "dependency", blocked_reason: "waiting for #1 to merge" },
    dependency_closed: { stage: "RUNNING", blocked_on: "human", blocked_reason: "dependency_closed:#1" },
    floor_tier: { stage: "RUNNING", blocked_on: "human", blocked_reason: "floor_tier" },
    failed_review: { stage: "REVIEW", blocked_on: "human", blocked_reason: "max_attempts" },
    failed_run: { stage: "REVIEW", blocked_on: "human", blocked_reason: "run_failed:update:invalid_output" },
    too_large: { stage: "RUNNING", blocked_on: "human", blocked_reason: "run_failed:implement:diff_too_large" },
    failed_implement: { stage: "RUNNING", blocked_on: "human", blocked_reason: "max_attempts" },
    agent_needs_human: { stage: "RUNNING", blocked_on: "human", blocked_reason: "agent_needs_human" },
    repeated_failure: { stage: "RUNNING", blocked_on: "human", blocked_reason: "repeated_failure" },
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
    const controller = new Controller({ store, source, auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner });
    const actor = { kind: "system" as const, id: "test" };
    /** A new work item on issue `n`, put in `phase`, with or without a PR. */
    const itemIn = async (phase: CommandPhase, pr: number | null, n: number) => {
      const { item } = await store.createWorkItem({ source: issueRef(n), requester_id: "github:1" as never, project: PROJECT_KEY, problem: "p", resources: [] }, actor);
      const setup = {
        id: item.id, expected_version: item.version, actor, reason: phase === "floor_tier" ? "floor_blocked" : "setup",
        patch: { ...PATCHES[phase], change_ref: pr === null ? null : String(pr), tier: 2 as const },
        ...(phase === "floor_tier" ? { detail: { required_tier: 3 } } : {}),
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

  /** The issue part of a footer: the PR block (if any) comes before it. */
  const issuePart = (footer: string) => footer.slice(footer.indexOf("Commands you can reply with now:"));

  it("for every phase, with and without a PR, a command is refused exactly when the footer leaves it out", async () => {
    const { source, controller, itemIn } = await harness();
    let n = 0;
    for (const phase of COMMAND_PHASES) {
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
    }
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
        pr: { pr_number: 42, head_branch: `${config.branch_prefix}${item.id}` },
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

  it("no refusal, /help or unknown-command reply in any state names a raw stage; /help names the state by its label", async () => {
    const { source, controller, itemIn } = await harness();
    const RAW = /\b(NEW|READY|RUNNING|REVIEW|CLOSED)\b/;
    const extra = (n: number): SourceEvent[] => {
      const base = { source: issueRef(n), comment_id: String(n), requester: alice };
      // /resolve last: at a merge conflict it applies, and the two replies before it describe the state.
      return [
        { kind: "help_requested", ...base, comment_id: `${n}h` },
        { kind: "unknown_command", ...base, comment_id: `${n}u`, command: "xyz" },
        { kind: "resolve_requested", ...base, notes: "", pr: null },
      ];
    };
    const stateOf = new Map<string, { phase: CommandPhase; pr: number | null }>();
    let n = 10_000;
    for (const phase of COMMAND_PHASES) {
      for (const pr of [null, 42]) {
        // One item per command, so each sees the state, not what an earlier command made of it.
        for (const make of [...ACTING.map((name) => (k: number) => [event(name, k)]), extra]) {
          n++;
          await itemIn(phase, pr, n);
          stateOf.set(issueRef(n).id, { phase, pr });
          for (const e of make(n)) await controller.handleEvent(e);
        }
        const help = source.comments.find((c) => c.marker === `<!-- factory:help:${n}h -->`)!;
        expect(help.body).toContain(`(${phaseLabel(phase)})`);
      }
    }
    const replies = source.comments.filter((c) => /^<!-- factory:(refused|help|unknown):/.test(c.marker));
    expect(replies.filter((c) => c.marker.includes(":refused:")).length).toBeGreaterThan(50);
    for (const c of replies) {
      expect({ ...stateOf.get(c.source.id), body: c.body, raw: RAW.test(c.body) }).toMatchObject({ raw: false });
    }
  });
});
