import { describe, expect, it } from "vitest";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import type { UserId, WorkItem, WorkItemPatch } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { GitHubIssueSource, statusLabels } from "../src/impl/github/github-issue-source.js";
import { LocalSource } from "../src/impl/source/local-source.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { FakeAuth, FakeGitHubClient, cleanScanner, config, issueRef, silent } from "./helpers/fakes.js";
import { PROJECT_KEY, issue, newStore, system } from "./helpers/store.js";

// Label state per item and target (design §5, GitHub call budget): the GitHub source compares the stored state
// before any call, and the start-up catch-up skips targets already showing their status.

const label = (status: string) => statusLabels("sf: ").find((l) => l.status === status)!.name;

/** One controller process: its own GitHub client (an empty ETag cache, as after a restart) on the shared store. */
function controllerOn(store: FactoryStore, clock: FakeClock) {
  const github = new FakeGitHubClient();
  const source = new GitHubIssueSource(github, { owner: "o", name: "r" }, "factory", "factory/", "main", "sf: ", store);
  const controller = new ControllerRole({ store, source, auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner });
  return { github, source, controller };
}

/** Writes to an issue's or PR's labels (adds and removals; label creation on the repo is not one). */
const labelWrites = (github: FakeGitHubClient, n?: number) => github.labelCalls(n).filter((c) => !c.startsWith("GET"));

async function itemIn(store: FactoryStore, n: number, patch: WorkItemPatch = {}): Promise<WorkItem> {
  const { item } = await store.createWorkItem(issue(n), system);
  if (Object.keys(patch).length === 0) return item;
  const r = await store.transition({ id: item.id, expected_version: item.version, actor: system, reason: "setup", patch });
  if (!r.ok) throw new Error("setup failed");
  return r.item;
}

describe("status catch-up on start", () => {
  it("a restart with 10 open items whose labels are unchanged makes 0 label calls", async () => {
    const { store, clock } = await newStore();
    for (let n = 1; n <= 10; n++) await itemIn(store, n);
    await controllerOn(store, clock).controller.catchUpStatus();

    const restarted = controllerOn(store, clock);
    await restarted.controller.catchUpStatus();
    expect(restarted.github.labelCalls()).toEqual([]);
  });

  it("an item with no stored label state (from before this change) gets one label write on start, and none on the next start", async () => {
    const { store, clock } = await newStore();
    await itemIn(store, 7);
    const first = controllerOn(store, clock);
    await first.controller.catchUpStatus();
    expect(labelWrites(first.github, 7)).toEqual(["POST /repos/o/r/issues/7/labels"]);
    expect(first.github.labels.get(7)).toEqual([label("triaging")]);
    expect(await store.listLabelStates([issueRef(7).id])).toEqual([
      expect.objectContaining({ source_id: issueRef(7).id, target: "issue", status: "triaging" }),
    ]);

    const next = controllerOn(store, clock);
    await next.controller.catchUpStatus();
    expect(next.github.calls).toEqual([]);
  });

  it("keeps label state per item and target: a current issue label does not hide a stale PR label", async () => {
    const { store, clock } = await newStore();
    await itemIn(store, 7, { stage: "REVIEW", change_ref: "42" });
    const first = controllerOn(store, clock);
    await first.controller.catchUpStatus();
    expect(labelWrites(first.github).sort()).toEqual(["POST /repos/o/r/issues/42/labels", "POST /repos/o/r/issues/7/labels"]);

    // The PR's stored state goes stale (an older write landed last); the issue's stays current.
    const token = (await store.claimLabelWrite(issueRef(7).id, "pr:42", "implementing", 60_000))!;
    await store.recordLabelState(issueRef(7).id, "pr:42", "implementing", token);

    const next = controllerOn(store, clock);
    next.github.labels.set(42, [label("implementing")]);
    await next.controller.catchUpStatus();
    expect(next.github.labelCalls(7)).toEqual([]);
    expect(labelWrites(next.github, 42)).toEqual(["POST /repos/o/r/issues/42/labels", `DELETE /repos/o/r/issues/42/labels/${encodeURIComponent(label("implementing"))}`]);
    expect(next.github.labels.get(42)).toEqual([label("in_review")]);
  });

  for (const backend of [{ name: "sqlite", make: newStore }]) {
    it(`two controllers starting at once on one store make one label write per item and target (${backend.name})`, async () => {
      const { store, clock } = await backend.make();
      for (let n = 1; n <= 5; n++) await itemIn(store, n, n % 2 === 0 ? { stage: "REVIEW", change_ref: String(100 + n) } : {});
      const a = controllerOn(store, clock);
      const b = controllerOn(store, clock);
      await Promise.all([a.controller.catchUpStatus(), b.controller.catchUpStatus()]);
      const writes = [...labelWrites(a.github), ...labelWrites(b.github)].sort();
      expect(writes).toEqual([
        "POST /repos/o/r/issues/1/labels", "POST /repos/o/r/issues/102/labels", "POST /repos/o/r/issues/104/labels",
        "POST /repos/o/r/issues/2/labels", "POST /repos/o/r/issues/3/labels", "POST /repos/o/r/issues/4/labels",
        "POST /repos/o/r/issues/5/labels",
      ]);
      const states = await store.listLabelStates([1, 2, 3, 4, 5].map((n) => issueRef(n).id));
      expect(states.every((s) => s.status !== null)).toBe(true);
    });
  }
});

describe("GitHubIssueSource.setStatus with a store", () => {
  it("a status change writes its label once and stores the new state; the same status again makes no GitHub call", async () => {
    const { store, clock } = await newStore();
    const { github, source } = controllerOn(store, clock);
    await source.setStatus(issueRef(7), "triaging", null);
    github.calls = [];

    await source.setStatus(issueRef(7), "needs_approval", null);
    expect(labelWrites(github, 7)).toEqual([
      "POST /repos/o/r/issues/7/labels", `DELETE /repos/o/r/issues/7/labels/${encodeURIComponent(label("triaging"))}`,
    ]);
    expect(github.labels.get(7)).toEqual([label("needs_approval")]);
    expect((await store.listLabelStates([issueRef(7).id]))[0]).toMatchObject({ target: "issue", status: "needs_approval" });

    github.calls = [];
    await source.setStatus(issueRef(7), "needs_approval", null);
    expect(github.calls).toEqual([]);
  });

  it("a failed write stores nothing and ends its claim, so the next call writes at once", async () => {
    const { store, clock } = await newStore();
    const { github, source } = controllerOn(store, clock);
    const real = github.request.bind(github);
    github.request = async (method, path, body) => {
      if (method === "POST" && path === "/repos/o/r/issues/7/labels") throw new Error("GitHub 502");
      return real(method, path, body);
    };
    await expect(source.setStatus(issueRef(7), "triaging", null)).rejects.toThrow("GitHub 502");
    expect((await store.listLabelStates([issueRef(7).id]))[0]).toMatchObject({ status: null });

    github.request = real;
    await source.setStatus(issueRef(7), "triaging", null);
    expect(github.labels.get(7)).toEqual([label("triaging")]);
    expect((await store.listLabelStates([issueRef(7).id]))[0]).toMatchObject({ status: "triaging" });
  });

  it("an unexpired claim on the same status writes nothing; an expired one is taken over", async () => {
    const { store, clock } = await newStore();
    expect(await store.claimLabelWrite("o/r#7", "issue", "triaging", 60_000)).not.toBeNull();
    expect(await store.claimLabelWrite("o/r#7", "issue", "triaging", 60_000)).toBeNull();
    // A different status is a newer write: it does not wait for the older one.
    const newer = await store.claimLabelWrite("o/r#7", "issue", "implementing", 60_000);
    expect(newer).not.toBeNull();
    clock.advance(60_001);
    const taken = await store.claimLabelWrite("o/r#7", "issue", "implementing", 60_000);
    expect(taken).not.toBeNull();
    // The write whose claim was taken over stores nothing.
    await store.recordLabelState("o/r#7", "issue", "implementing", newer!);
    expect((await store.listLabelStates(["o/r#7"]))[0]!.status).toBeNull();
    await store.recordLabelState("o/r#7", "issue", "implementing", taken!);
    expect((await store.listLabelStates(["o/r#7"]))[0]!.status).toBe("implementing");
  });
});

describe("solo setup", () => {
  it("with no GitHub source, nothing writes to the new tables", async () => {
    const { store, clock } = await newStore();
    const { item } = await store.createWorkItem(
      { source: { type: "local", id: "local-1", link: "local:local-1" }, requester_id: "local:owner" as UserId, project: PROJECT_KEY, problem: "p", resources: [] },
      system,
    );
    const controller = new ControllerRole({ store, source: new LocalSource(store), auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner });
    await controller.catchUpStatus();
    // A refused app request posts its reply through the local source.
    await store.recordAppCommandRequest({ key: "k1", actor: "local:someone" as UserId, command: "frobnicate", args: { work_item_id: item.id } });
    await controller.tickCommands();
    expect(await store.listItemMessages(item.id)).toHaveLength(1);
    for (const table of ["outbound_deliveries", "outbound_label_states"]) {
      expect((await store.listTableRows({ table }))?.total, table).toBe(0);
    }
  });
});

describe("schema", () => {
  it("SQLite builds posted_comments and label_states on open", async () => {
    const { store } = await newStore();
    const names = (await store.listTables()).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["outbound_deliveries", "outbound_label_states"]));
  });
});
