import { describe, expect, it } from "vitest";
import { COMMANDS, approveRefusal, chatHelpReply, commandSpec, helpReply, parseComment, refusalText, withSlash } from "../src/core/commands.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import type { UserId, WorkItem, WorkItemPatch } from "../src/core/types.js";
import { runLocalCli } from "../src/core/local-cli.js";
import { githubCommand } from "../src/core/command-inbox.js";
import type { AuthProvider } from "../src/interfaces/auth-provider.js";
import { answersDetail, splitAnswers } from "../src/shared/command-notes.js";
import { FakeSource } from "./helpers/fakes/source.js";
import { cleanScanner, config, issueRef, silent } from "./helpers/fakes/config.js";
import { newStore, PROJECT_KEY, system } from "./helpers/store.js";

describe("one refusal and help text on every surface (issue #528)", () => {
  const ME = "github:1" as UserId;
  const auth: AuthProvider = { resolve: async (i) => ({ user_id: `${i.provider}:${i.subject}` as UserId }), authorize: async () => ({ allow: true }) };

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
    const cli = { answers: { split: splitAnswers, detail: answersDetail }, store, identity: { user: ME, from: "cli_user" as const }, project: async () => PROJECT_KEY, read: async () => "", newId: () => `n${++comments}` };
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
