import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMMANDS, COMMAND_PHASES, type CommandPhase, applies, appliesOnPr, chatHelpReply, commandFooter, commandPhase, commandSpec, commandState, commandsFor, commandTableMarkdown, helpReply, parseComment, phaseLabel, prCommandsFor, unknownCommandReply } from "../src/core/commands.js";
import { itemCommands } from "../src/ui/commands.js";
import { COMMAND_TABLE, cliHelpLine, cliUsageOf } from "../src/core/command-table.js";
import type { WorkItem } from "../src/core/types.js";
import { alice, issueRef } from "./helpers/fakes/config.js";

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
    const f = commandFooter(s("merged", true)).split("\n");
    expect(f.at(-2)).toMatch(/^- `\/help`/);
    expect(f.at(-1)).toBe("No command changes this item's state now.");
  });

  it("a failure footer names each command with its first sentence only and points to /help for the rest", () => {
    const f = commandFooter(s("failed_implement")).split("\n");
    const retry = f.find((l) => l.startsWith("- `/retry`"));
    expect(retry).toBe("- `/retry`: Run the failed run again.");
    expect(f.join("\n")).not.toContain("+paths");
    expect(f.at(-1)).toBe(`- \`/help\`: ${commandSpec("help").description}.`);
    // /help keeps every command's full text.
    expect(helpReply(s("failed_implement"))).toContain(`: ${commandSpec("retry").description}.`);
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
    expect(helpReply(s("failed_review", true))).toContain("`/revise <feedback>` **(now, on the PR)**: Get a new spec written with your feedback. While implementing: queue your feedback for one more implement run on the item's branch when the run ends, before review. On the PR:");
    expect(commandsFor(s("implementing")).find((c) => c.name === "revise")!.description).toMatch(/^While implementing: queue your feedback/);
    // On a New or in-triage item it adds context, queued for one re-triage (design 02-attachments).
    expect(commandsFor(s("triaging")).find((c) => c.name === "revise")!.description).toMatch(/^On a New or in-triage item: add context/);
    expect(commandTableMarkdown()).toMatch(/\| `\/revise <feedback>` \|[^\n]*On a New or in-triage item: add context[^\n]*\| triaging, spec waiting for approval/);
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

  it("/revise has a local meaning at the merge wait on a local item with no PR (issue #563)", async () => {
    const revise = commandSpec("revise");
    const item = (type: string, change_ref: string | null, blocked_reason = "merge_pending") => ({
      stage: "REVIEW" as const, blocked_on: "human" as const, blocked_reason, change_ref, source: { type, id: "x", link: "x" },
    });
    const local = commandState(item("local", null));
    expect(local).toEqual({ phase: "merge_pending", has_pr: false, local: true });
    expect(applies(revise, local)).toBe(true);
    const shown = commandsFor(local).find((c) => c.name === "revise")!;
    expect(shown.description).toMatch(/implementer/);
    expect(shown.description).toMatch(/local branch/);
    expect(shown.description).not.toContain("On the PR");
    expect(shown.description).not.toBe(revise.description);
    const footer = commandFooter(local);
    expect(footer).not.toContain("On the change");
    expect(footer).toContain(`- \`/revise <feedback>\`: ${shown.description}.`);
    expect(footer).not.toContain("No command changes this item's state now.");
    const help = helpReply(local).split("\n").find((l) => l.startsWith("- `/revise <feedback>`"))!;
    expect(help).toBe(`- \`/revise <feedback>\` **(now)**: ${shown.description}.`);
    // A local item with a PR, a GitHub or Slack item, and a local item in any other phase: as before.
    expect(applies(revise, commandState(item("local", "42")))).toBe(false);
    for (const type of ["github_issue", "slack_thread"]) expect(applies(revise, commandState(item(type, null))), type).toBe(false);
    for (const phase of COMMAND_PHASES) {
      const s = { phase, has_pr: false, local: true as const };
      expect({ phase, on: applies(revise, s) }).toEqual({ phase, on: phase === "merge_pending" || revise.phases.includes(phase) });
      // Implementing and triaging have their own meaning (the queued /revise, added context), checked in the command table tests.
      if (phase !== "merge_pending" && phase !== "implementing" && phase !== "triaging" && applies(revise, s)) expect(commandsFor(s).find((c) => c.name === "revise")!.description).toBe(revise.description);
    }
    expect(applies(revise, commandState(item("local", null, "run_failed:review:invalid_output")))).toBe(false);
    // The item API offers it with the local description, under the same grant as approve.
    const it = item("local", null) as unknown as WorkItem;
    const rows = await itemCommands(it, [], { allow: false, reason: "no role" }, async (v) => v);
    expect(rows.find((r) => r.name === "revise")).toEqual({ name: "revise", usage: "/revise <feedback>", description: shown.description, allowed: false, reason: "no role" });
    expect((await itemCommands(it, [], { allow: true }, async (v) => v)).find((r) => r.name === "revise")?.allowed).toBe(true);
    expect(commandTableMarkdown()).toContain(`. ${revise.local_description}. ${revise.triaging_description} |`);
    expect(commandTableMarkdown()).toContain("; on a local item with no PR: waiting for a human merge; on its PR: ");
  });

  it("/hold <id> applies only to a local item with no PR whose implement run asked for a human; its help text is the hold reply option", () => {
    const hold = commandSpec("hold");
    expect(hold.usage).toBe("/hold <id>");
    expect(hold.description).toMatch(/^Hold until <id> merges: writes a `Depends on: <id>` line/);
    const local = { phase: "agent_needs_human" as const, has_pr: false, local: true as const };
    expect(applies(hold, { ...local, asked_by: "implement" })).toBe(true);
    expect(commandFooter({ ...local, asked_by: "implement" })).toContain(`- \`/hold <id>\`: ${hold.description.split(". Refused")[0]}.\n`);
    // A resolve run that asked, any other phase, a GitHub item, or a local item's PR: not offered.
    expect(applies(hold, { ...local, asked_by: "resolve" })).toBe(false);
    for (const phase of COMMAND_PHASES.filter((p) => p !== "agent_needs_human")) expect(applies(hold, { phase, has_pr: false, local: true }), phase).toBe(false);
    expect(applies(hold, { phase: "agent_needs_human", has_pr: false, asked_by: "implement" })).toBe(false);
    expect(applies(hold, { ...local, has_pr: true, asked_by: "implement" })).toBe(false);
    expect(commandTableMarkdown()).toContain(`| \`/hold <id>\` | ${hold.description}. ${hold.table_note} | on a local item with no PR: blocked: the agent asked for a human |`);
    expect(hold.table_note).toContain("implement run is queued and not started");
    expect(helpReply({ ...local, asked_by: "implement" })).toContain("`/hold <id>` **(now)**: Hold until <id> merges");
  });

  it("at max_loops after a failed merge check, /help marks `factory merge <id>` and not /retry; chat help lists merge; without it, /retry as before", () => {
    const stopped = { phase: "max_loops", has_pr: false, local: true, merge_check: true } as const;
    const help = helpReply(stopped);
    expect(help).toContain("- `factory merge <id>` **(now)**: The owner checks the merged result once more");
    expect(help).not.toContain("- `/retry` **(now)**");
    expect(help).toContain("- `/revise <feedback>` **(now)**");
    expect(applies(commandSpec("retry"), stopped)).toBe(false);
    expect(commandFooter(stopped)).not.toContain("`/retry`");
    expect(chatHelpReply(() => true, stopped)).toContain("- `merge`:");
    const loops = { phase: "max_loops", has_pr: false, local: true } as const;
    expect(helpReply(loops)).toContain("- `/retry` **(now)**");
    expect(helpReply(loops)).not.toContain("- `factory merge <id>` **(now)**");
    expect(chatHelpReply(() => true, loops)).not.toContain("- `merge`:");
  });

  it("/help names the state by its label, not its phase id", () => {
    expect(helpReply(s("spec_pending"))).toContain("(spec waiting for approval)");
    expect(helpReply(s("spec_pending"))).not.toContain("spec_pending");
    expect(helpReply(s("too_large"))).toContain("(blocked: the change was too large)");
    expect(helpReply(s("too_large"))).toContain("`/revise <feedback>` **(now)**");
    expect(helpReply(s("failed_implement"))).not.toContain("failed_implement");
  });

  it("a held phase of a split is its own phase, where /retry applies and says it releases the phase (design 04-split-specs)", () => {
    expect(commandPhase({ stage: "NEW", blocked_on: "upstream", blocked_reason: "phase_hold", change_ref: null })).toBe("phase_hold");
    // Another upstream block is still "other blocked".
    expect(commandPhase({ stage: "NEW", blocked_on: "upstream", blocked_reason: "something", change_ref: null })).toBe("other_blocked");
    expect(phaseLabel("phase_hold")).toBe("held: waiting for the previous phase of its split");
    const retry = commandSpec("retry");
    expect(applies(retry, s("phase_hold"))).toBe(true);
    expect(retry.description).toContain("On a held phase of a split, it releases the phase into triage once the previous phase closed without a merge");
    expect(helpReply(s("phase_hold"))).toContain("(held: waiting for the previous phase of its split)");
    expect(helpReply(s("phase_hold"))).toContain("`/retry` **(now)**");
    const row = commandTableMarkdown().split("\n").find((l) => l.startsWith("| `/retry` |"))!;
    expect(row).toContain("held: waiting for the previous phase of its split");
    expect(commandsFor(s("other_blocked")).map((c) => c.name)).not.toContain("retry");
  });

  it("an item released by its interactive session is its own phase, where /retry applies and /revise and /approve do not", () => {
    expect(commandPhase({ stage: "RUNNING", blocked_on: "human", blocked_reason: "session_released", change_ref: null })).toBe("session_released");
    expect(phaseLabel("session_released")).toBe("released: its session ended without a PR");
    expect(commandsFor(s("session_released")).map((c) => c.name)).toContain("retry");
    for (const name of ["revise", "approve"] as const) expect(applies(commandSpec(name), s("session_released"))).toBe(false);
    expect(helpReply(s("session_released"))).toContain("(released: its session ended without a PR)");
    expect(helpReply(s("session_released"))).toContain("`/retry` **(now)**");
    const row = commandTableMarkdown().split("\n").find((l) => l.startsWith("| `/retry` |"))!;
    expect(row).toContain("released: its session ended without a PR");
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
