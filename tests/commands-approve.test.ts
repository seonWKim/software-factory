import { describe, expect, it } from "vitest";
import { commandState, commandsFor, parseComment } from "../src/core/commands.js";
import { autoApprovedFooter, utcMinute } from "../src/core/spec-comment.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import type { SourceRef, UserId, WorkItem, WorkItemId } from "../src/core/types.js";
import { runLocalCli } from "../src/core/local-cli.js";
import { githubCommand } from "../src/core/command-inbox.js";
import type { AuthProvider } from "../src/interfaces/auth-provider.js";
import { answersDetail, splitAnswers, storedAnswers } from "../src/shared/command-notes.js";
import { FakeAuth } from "./helpers/fakes/runner.js";
import { FakeSlackPollSource, FakeSource } from "./helpers/fakes/source.js";
import { alice, cleanScanner, config, issueRef, silent, slackRef, triageSpec } from "./helpers/fakes/config.js";
import { pipeline } from "./helpers/harness.js";
import { newStore, PROJECT_KEY, system, w1 } from "./helpers/store.js";

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
    resolve: async (i) => ({ user_id: `${i.provider}:${i.subject}` as UserId }),
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
    const cli = { answers: { split: splitAnswers, detail: answersDetail }, store: h.store, identity: { user: ME, from: "git user.email" as const }, project: async () => PROJECT_KEY, read: async () => "", newId: () => "x" };
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
      "`/approve` was not applied: only the owner may send this command (`not_a_collaborator`).",
      "`/revise` was not applied: only the owner may send this command (`not_a_collaborator`).",
    ]);
  });

  it("a dashboard /approve reads no +paths: the line stays in its note and allowed_paths are as they were (design 09-dashboard-item-commands)", async () => {
    const h = await harness();
    const it = await h.triaged(issueRef(95), []);
    await h.store.recordAppCommandRequest({ key: "k95", actor: ME, command: "approve", args: { work_item_id: it.id, note: "+paths docs/x.md" } });
    await h.controller.tickCommands();
    expect(await h.store.getWorkItem(it.id)).toMatchObject({ stage: "RUNNING", allowed_paths: it.allowed_paths });
    expect((await h.approval(it.id))!.detail?.note).toBe("+paths docs/x.md");
  });

  describe("an option that needs a path outside the allowed paths (design 04-spec-gate-commands, 2026-11-21)", () => {
    const WIDE = [{
      ...DECISIONS[0]!,
      option_changes: [{ option: "Only warn", extra_paths: ["docs/ci.md"], done_when: ["CI warns when files outside allowed_paths change"] }],
    }];
    const REPLY = "`/approve +paths docs/ci.md`";
    const implementRuns = async (h: Awaited<ReturnType<typeof harness>>, id: WorkItemId) => (await h.store.listRuns(id)).filter((r) => r.kind === "implement");

    it("is refused from a comment, Slack, the CLI and the dashboard with one reply naming the path and the +paths reply; nothing is queued or widened", async () => {
      const h = await harness();
      const byComment = await h.triaged(issueRef(70), WIDE);
      const bySlack = await h.triaged(slackRef(71), WIDE);
      const byCli = await h.triaged(issueRef(72), WIDE);
      const byApp = await h.triaged(issueRef(73), WIDE);
      // Each delivered twice (a second poll): still one reply.
      for (const _ of [1, 2]) {
        await h.controller.handleEvent({ kind: "spec_approved", source: byComment.source, comment_id: "w1", approver: alice, note: "1: Only warn" });
        await h.controller.handleEvent({ kind: "spec_approved", source: bySlack.source, comment_id: "w2", approver: { provider: "slack", subject: "U2", login: "u" }, note: "1: Only warn" });
      }
      const cli = { answers: { split: splitAnswers, detail: answersDetail }, store: h.store, identity: { user: ME, from: "git user.email" as const }, project: async () => PROJECT_KEY, read: async () => "", newId: () => "x" };
      expect((await runLocalCli(cli, { action: "command", command: "approve", id: byCli.id, text: "1: Only warn" })).code).toBe(0);
      await h.store.recordAppCommandRequest({ key: "k73", actor: ME, command: "approve", args: { work_item_id: byApp.id, note: "1: Only warn" } });
      await h.controller.tickCommands();

      for (const [name, it, marker] of [["comment", byComment, "w1"], ["slack", bySlack, "w2"]] as const) {
        const replies = (await h.store.listItemMessages(it.id)).filter((m) => m.marker === `<!-- factory:refused:${marker} -->`);
        expect(replies, name).toHaveLength(1);
        expect(replies[0]!.body, name).toContain("`docs/ci.md`");
        expect(replies[0]!.body, name).toContain(REPLY);
      }
      const app = (await h.store.listAppCommandRequestsForItem(byApp.id, 5)).at(-1)!;
      expect(app.refusal).toContain(REPLY);
      for (const [name, it] of [["comment", byComment], ["slack", bySlack], ["cli", byCli], ["app", byApp]] as const) {
        const now = (await h.store.getWorkItem(it.id))!;
        expect(now, name).toMatchObject({ stage: "READY", blocked_reason: "spec_pending", allowed_paths: it.allowed_paths });
        expect(await h.approval(it.id), name).toBeUndefined();
        expect(await implementRuns(h, it.id), name).toEqual([]);
      }
    });

    it("an approval whose +paths covers the option's path starts the implement run with the widened allowed_paths", async () => {
      const h = await harness();
      const it = await h.triaged(issueRef(80), WIDE);
      await h.comment(it, "/approve +paths docs/ci.md\n1: Only warn");
      const now = (await h.store.getWorkItem(it.id))!;
      expect(now).toMatchObject({ stage: "RUNNING", blocked_on: "none" });
      expect(now.allowed_paths).toEqual([...it.allowed_paths, "docs/ci.md"]);
      expect(await implementRuns(h, it.id)).toHaveLength(1);
      expect(storedAnswers((await h.approval(it.id))!.detail)[0]).toEqual({ question: DECISIONS[0]!.question, answer: "Only warn", accepted_default: false });
    });

    it("the default option needs no extra path: an approval with it starts the run with allowed_paths as they were", async () => {
      const h = await harness();
      const it = await h.triaged(issueRef(90), WIDE);
      await h.controller.handleEvent({ kind: "spec_approved", source: it.source, comment_id: "d9", approver: alice, note: "1: Fail the job" });
      const now = (await h.store.getWorkItem(it.id))!;
      expect(now).toMatchObject({ stage: "RUNNING", allowed_paths: it.allowed_paths });
      expect(await implementRuns(h, it.id)).toHaveLength(1);
    });
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
