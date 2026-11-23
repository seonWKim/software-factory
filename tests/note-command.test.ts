import { describe, expect, it } from "vitest";
import { COMMAND_TABLE, chatCliArgv, parseChatCommand } from "../src/core/command-table.js";
import { githubCommand } from "../src/core/command-inbox.js";
import { commentEvent } from "../src/core/comment-event.js";
import { helpReply, parseComment } from "../src/core/commands.js";
import { OWNER_NOTE } from "../src/controller/units/commands/note.js";
import { parseLocalCliArgs, runLocalCli } from "../src/core/local-cli.js";
import { parseReview } from "../src/core/outputs.js";
import type { UserId, WorkItem } from "../src/core/types.js";
import type { AgentRunSpec } from "../src/interfaces/agent-runner.js";
import { threadRows } from "../src/ui/thread.js";
import { answersDetail, splitAnswers } from "../src/shared/command-notes.js";
import { alice, issueRef } from "./helpers/fakes/config.js";
import { pipeline } from "./helpers/harness.js";

// `/note <text>` (design 04-gate-commands, 2026-11-23): the owner adds a note at any open stage; it is stored on the
// item as an `owner_note` state change with no stage change, shown in the item's thread, and read into the review and
// implement inputs' "Notes from the approver" section.

const LINE = "every /api/usecases route is limited";
const REASON = "limit only /greet and the supervision routes";
/** The CLI identity: the pipeline's auth resolves its subject `1` to the owner, `github:1`. */
const ME = "local:1" as UserId;

/** The "Notes from the approver" section of a prompt, up to the next section; "" when absent. */
function approverSection(prompt: string): string {
  const at = prompt.indexOf("## Notes from the approver");
  if (at < 0) return "";
  const next = prompt.indexOf("\n## ", at + 1);
  return next < 0 ? prompt.slice(at) : prompt.slice(at, next);
}

/**
 * A factory whose review lists LINE built differently, with REASON when its approver section carries REASON, else no
 * reason (the parser makes that a finding). `submit` approves an item, which queues its implement run.
 */
async function harness() {
  const f = await pipeline({ config: { dials: { spec_gate_min_tier: 1, auto_merge_max_tier: 0 } } });
  f.runner.script.review = (spec: AgentRunSpec) => ({
    output: {
      verdict: "pass", tier: 2, findings: [], summary: "s",
      built_differently: [{ line: LINE, reason: approverSection(spec.prompt).includes(REASON) ? REASON : "" }],
    },
  });
  let comments = 0;
  const approved = async (): Promise<WorkItem> => {
    const it = await f.submit();
    await f.step();
    await f.controller.handleEvent({ kind: "spec_approved", source: it.source, comment_id: `a-${it.id}`, approver: alice, note: "approval note" });
    return f.item(it);
  };
  /** A GitHub comment by `user` on `it`'s issue, as the issue source stores it, then a controller tick. */
  const comment = async (it: WorkItem, body: string, user = 1) => {
    const parsed = parseComment(body);
    if (parsed?.kind !== "command") throw new Error(`not a command: ${body}`);
    await f.store.appendCliCommand(githubCommand({ comment_id: 700 + ++comments, user_id: user, command: parsed.name, text: parsed.text, source: it.source }));
    await f.controller.tickCommands();
  };
  const notes = async (it: WorkItem) => (await f.store.listStateChanges(it.id)).filter((c) => c.reason === OWNER_NOTE);
  const prompts = (role: AgentRunSpec["role"]) => f.runner.specs.filter((s) => s.role === role).map((s) => s.prompt);
  const reviews = async (it: WorkItem) => (await f.runs(it, "review")).map((r) => (r.outcome as unknown as { data: { review: unknown } }).data.review);
  const cli = { answers: { split: splitAnswers, detail: answersDetail }, store: f.store, identity: { user: ME, from: "git user.email" as const }, project: async () => null, read: async () => "", newId: () => `n${++comments}` };
  return { ...f, approved, comment, notes, prompts, reviews, cli };
}

describe("/note: the command table, the parsers and help", () => {
  it("is in the command table as `task note <id> <text>`, an owner command whose chat form is `/note <text>`", () => {
    const entry = COMMAND_TABLE.find((c) => c.name === "task note");
    expect(entry).toMatchObject({ args: "<id> <text>", who: "approve_spec", chat: "/note <text>", item: true, edge: false });
  });

  it("the comment parser reads it as a command with its text, which maps to no source event", () => {
    expect(parseComment("/note the reason\nsecond line")).toEqual({ kind: "command", name: "note", text: "the reason\nsecond line" });
    expect(commentEvent(issueRef(1), "c1", alice, "/note the reason")).toBeNull();
  });

  it("the chat form stands for `factory task note <id> <text>`, which the CLI parser reads as the `note` command", () => {
    const chat = parseChatCommand("/note the reason");
    expect(chat).toMatchObject({ kind: "command", entry: { name: "task note" }, text: "the reason" });
    const argv = chatCliArgv(chat as Extract<typeof chat, { kind: "command" }>, "wi_1");
    expect(argv).toEqual({ word: "task", args: ["note", "wi_1", "the reason"] });
    expect(parseLocalCliArgs(argv.word, argv.args)).toEqual({ action: "command", command: "note", id: "wi_1", text: "the reason" });
    expect(parseLocalCliArgs("task", ["note", "wi_1"])).toHaveProperty("error");
  });

  it("`/help` lists it", () => {
    expect(helpReply(null)).toContain("`/note <text>`");
    expect(helpReply(null)).toContain("`factory task note <id> <text>`");
  });
});

describe("/note on an item", () => {
  it("with a run queued: stored on the item, shown in its thread, and no stage changes", async () => {
    const h = await harness();
    const it = await h.approved();
    expect((await h.runs(it, "implement")).some((r) => r.status === "queued")).toBe(true);
    await h.comment(it, `/note ${REASON}`);
    const after = await h.item(it);
    expect(after).toMatchObject({ stage: it.stage, blocked_on: it.blocked_on, blocked_reason: it.blocked_reason });
    const [note] = await h.notes(it);
    expect(note).toMatchObject({ actor: { kind: "user", id: "github:1" }, detail: { note: REASON } });
    expect(note!.changes ?? {}).toEqual({});
  });

  it("in review: stored, no stage changes, and the review's approver notes carry it, so the line built differently is no finding", async () => {
    const h = await harness();
    const it = await h.approved();
    await h.w1.tick(); // the implement run
    await h.controller.tickRuns();
    const inReview = await h.item(it);
    expect(inReview.stage).toBe("REVIEW");
    await h.comment(it, "/note an earlier note");
    await h.comment(it, `/note ${REASON}`);
    expect(await h.item(it)).toMatchObject({ stage: "REVIEW", blocked_on: inReview.blocked_on, blocked_reason: inReview.blocked_reason });
    await h.step();
    const section = approverSection(h.prompts("review").at(-1)!);
    expect(section).toContain("Untrusted text");
    const earlier = section.indexOf("```text\nan earlier note\n```");
    const reason = section.indexOf("```text\n" + REASON + "\n```");
    expect(earlier).toBeGreaterThan(-1);
    expect(reason).toBeGreaterThan(earlier);
    const review = (await h.reviews(it)).at(-1) as { verdict: string; findings: unknown[]; built_differently: unknown };
    expect(review).toMatchObject({ verdict: "pass", findings: [], built_differently: [{ line: LINE, reason: REASON }] });
  });

  it("the implementer's input shows the same owner notes section", async () => {
    const h = await harness();
    const it = await h.approved();
    await h.comment(it, `/note ${REASON}`);
    await h.step();
    const implement = approverSection(h.prompts("implement").at(-1)!);
    expect(implement).toContain("```text\n" + REASON + "\n```");
    expect(approverSection(h.prompts("review").at(-1)!).trim()).toBe(implement.trim());
  });

  it("a note from before the latest approval is not shown", async () => {
    const h = await harness();
    const it = await h.submit();
    await h.step();
    await h.comment(it, "/note before the approval");
    expect(await h.notes(it)).toHaveLength(1);
    await h.controller.handleEvent({ kind: "spec_approved", source: it.source, comment_id: "a1", approver: alice });
    await h.step();
    expect(h.prompts("implement").at(-1)!).not.toContain("before the approval");
  });

  it("an implementer's interactive note is no reason: the line built differently is still a finding", async () => {
    const h = await harness();
    h.runner.script.implement = () => ({ output: { summary: `interactive note: ${REASON}`, next_steps: `interactive note: ${REASON}` } });
    const it = await h.approved();
    await h.step();
    expect(approverSection(h.prompts("review").at(-1)!)).not.toContain(REASON);
    const review = (await h.reviews(it)).at(-1) as { verdict: string; findings: unknown[] };
    expect(review.verdict).toBe("bug");
    expect(review.findings).toEqual([{ kind: "code", text: `built differently from the spec with no reason in the work item: ${LINE}` }]);
    // The same answer with the owner's reason parses with no finding.
    expect(parseReview({ verdict: "pass", tier: 2, findings: [], summary: "s", built_differently: [{ line: LINE, reason: REASON }] })).toMatchObject({ ok: true, value: { verdict: "pass", findings: [] } });
  });

  it("a non-owner's `/note` is refused with one reply and stores nothing", async () => {
    const h = await harness();
    const it = await h.approved();
    await h.comment(it, `/note ${REASON}`, 2);
    expect(await h.notes(it)).toEqual([]);
    const replies = (await h.store.listItemMessages(it.id)).filter((m) => m.body.includes("`/note` was not applied"));
    expect(replies).toHaveLength(1);
  });

  it("`/note` with no text, and a note on a closed item, are refused and store nothing", async () => {
    const h = await harness();
    const it = await h.approved();
    await h.comment(it, "/note");
    expect(await h.notes(it)).toEqual([]);
    expect((await h.store.listItemMessages(it.id)).some((m) => m.body.includes("`/note` needs text"))).toBe(true);
    await h.comment(it, "/reject done here");
    expect((await h.item(it)).stage).toBe("CLOSED");
    await h.comment(it, "/note too late");
    expect(await h.notes(it)).toEqual([]);
    const cli = await runLocalCli(h.cli, { action: "command", command: "note", id: it.id, text: "too late" });
    expect(cli.code).not.toBe(0);
  });

  it("`factory task note <id> <text>` stores the same note as the chat `/note`, and the thread shows it", async () => {
    const h = await harness();
    const it = await h.approved();
    const typed = await runLocalCli(h.cli, { action: "command", command: "note", id: it.id, text: REASON });
    expect(typed.code).toBe(0);
    expect(typed.lines[0]).toContain("stored `/note`");
    await h.controller.tickCommands();
    const [note] = await h.notes(it);
    expect(note).toMatchObject({ actor: { kind: "user", id: "github:1" }, detail: { note: REASON } });
    expect((await h.item(it)).stage).toBe(it.stage);
    const rows = await threadRows(h.store, it.id, it.source.type, async (t) => t, await h.store.listStateChanges(it.id));
    expect(rows.find((r) => r.kind === "note")).toMatchObject({ role: "owner", author: ME, channel: "cli", body: REASON });
    // Read again (a restart), it stores nothing more.
    await h.controller.tickCommands();
    expect(await h.notes(it)).toHaveLength(1);
  });
});
