import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  COMMANDS, COMMAND_PHASES, type CommandName, type CommandPhase, applies, commandFooter, commandPhase, commandState,
  commandTableMarkdown, helpReply, parseComment, unknownCommandReply,
} from "../src/core/commands.js";
import { Controller } from "../src/core/controller.js";
import type { WorkItemPatch } from "../src/core/types.js";
import type { SourceEvent } from "../src/interfaces/source-adapter.js";
import { FakeAuth, FakeSource, alice, cleanScanner, config, issueRef, silent } from "./helpers/fakes.js";
import { newStore } from "./helpers/store.js";

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
  });

  it("SET_UP.md has the command table from code", () => {
    const setup = readFileSync(new URL("../SET_UP.md", import.meta.url), "utf8");
    expect(setup).toContain(commandTableMarkdown());
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
    floor_tier: { stage: "RUNNING", blocked_on: "human", blocked_reason: "floor_tier" },
    failed_run: { stage: "RUNNING", blocked_on: "human", blocked_reason: "max_attempts" },
    reviewing: { stage: "REVIEW" },
    merge_pending: { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending" },
    max_loops: { stage: "REVIEW", blocked_on: "human", blocked_reason: "max_loops" },
    merge_conflict: { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_conflict_pending" },
    other_blocked: { stage: "RUNNING", blocked_on: "ci", blocked_reason: "something" },
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

  it("for every phase, with and without a PR, a command is refused exactly when the footer leaves it out", async () => {
    const { store, clock } = await newStore();
    const source = new FakeSource();
    const controller = new Controller({ store, source, auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner });
    const actor = { kind: "system" as const, id: "test" };
    let n = 0;
    for (const phase of COMMAND_PHASES) {
      for (const pr of [null, 42]) {
        const state = { phase, has_pr: pr !== null };
        const footer = commandFooter(state);
        for (const name of ACTING) {
          n++;
          const { item } = await store.createWorkItem({ source: issueRef(n), requester_id: "github:1" as never, project: "o/r", problem: "p", resources: [] }, actor);
          const setup = {
            id: item.id, expected_version: item.version, actor, reason: phase === "floor_tier" ? "floor_blocked" : "setup",
            patch: { ...PATCHES[phase], pr_number: pr, tier: 2 as const },
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
          expect(commandPhase(r.item)).toBe(phase);
          expect(commandState(r.item)).toEqual(state);
          await controller.handleEvent(event(name, n));
          const refused = source.comments.some((c) => c.marker === `<!-- factory:refused:${n} -->`);
          const spec = COMMANDS.find((c) => c.name === name)!;
          expect({ phase, pr, name, accepted: !refused }).toEqual({ phase, pr, name, accepted: applies(spec, state) });
          expect({ phase, pr, name, listed: footer.includes(`\`${spec.usage}\``) }).toEqual({ phase, pr, name, listed: !refused });
        }
      }
    }
  });
});
