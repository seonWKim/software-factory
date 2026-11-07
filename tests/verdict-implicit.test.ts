import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Controller } from "../src/core/controller.js";
import type { SourceRef, WorkItem } from "../src/core/types.js";
import type { AuthAction, AuthDecision, AuthProvider, ExternalIdentity, Principal } from "../src/interfaces/auth-provider.js";
import type { ForgeEvent } from "../src/interfaces/forge.js";
import type { SourceEvent } from "../src/interfaces/source-adapter.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { INLINE_STEPS, STEPS_DIR, readSteps } from "../src/impl/store/mysql/migrations.js";
import { SqlFactoryStore } from "../src/impl/store/sql/sql-factory-store.js";
import { MIGRATIONS } from "../src/impl/store/sqlite/schema.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
import { FakeAuth, FakeForge, FakeSource, alice, cleanScanner, config, issueRef, recordingLog } from "./helpers/fakes.js";
import { newStore, system, PROJECT_KEY } from "./helpers/store.js";

// Implicit verdicts (design §4, issue #316): a merge, a person's push and a revert of a factory PR each record one
// verdict, one per PR head, that an explicit `/verdict` on that head replaces. Never pin a step as the newest.

const STEP = 38;
const STEP_FILE = "0038-implicit-verdicts.sql";

/** An identity FakeAuth does not resolve. */
const stranger: ExternalIdentity = { provider: "github", subject: "999", login: "stranger" };

/** FakeAuth, except that `stranger` maps to no user. */
class StrangerAuth implements AuthProvider {
  private readonly inner = new FakeAuth();
  async resolve(identity: ExternalIdentity): Promise<Principal | null> {
    return identity.subject === stranger.subject ? null : this.inner.resolve(identity);
  }
  authorize(p: Principal, action: AuthAction): Promise<AuthDecision> {
    return this.inner.authorize(p, action);
  }
}

async function setup() {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const source = new FakeSource();
  const forge = new FakeForge(source);
  const log = recordingLog();
  const controller = new Controller({ store, source, forge, auth: new StrangerAuth(), clock, config, log, scanner: cleanScanner });
  return { store, source, forge, log, controller };
}
type F = Awaited<ReturnType<typeof setup>>;

/** Issue #7 as a factory item in REVIEW waiting for a merge of PR #42, its head h1 recorded. */
async function item(f: F, adopted = false): Promise<WorkItem> {
  const { item } = await f.store.createWorkItem(
    {
      source: issueRef(7), requester_id: "github:1" as WorkItem["requester_id"], project: PROJECT_KEY, problem: "p", resources: [],
      ...(adopted ? { adopted: { pr_number: 42, head_branch: "feature/x", head_sha: "h1", allowed_paths: ["a"], tier: 1 } } : {}),
    },
    system,
  );
  if (adopted) return item;
  const r = await f.store.transition({
    id: item.id, expected_version: item.version, actor: system, reason: "test",
    patch: { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", pr_number: 42 },
  });
  if (!r.ok) throw new Error(r.reason);
  const h = await f.store.recordPrHead({ id: item.id, expected_head: null, head_sha: "h1", manual: null });
  if (!h.ok) throw new Error(h.reason);
  return h.item;
}

const MERGE_SHA = "aaaa1111";
const branch = (it: WorkItem) => it.head_branch ?? `factory/${it.id}`;
const merged = (it: WorkItem, merger: ExternalIdentity | null = alice): ForgeEvent => ({
  kind: "pr_merged", pr_number: 42, head_branch: branch(it), merge_sha: MERGE_SHA, merger,
});
const prRef: SourceRef = { type: "github_issue", id: "o/r#42", link: "https://github.com/o/r/pull/42" };
const pushed = (it: WorkItem, head_sha: string): ForgeEvent => ({
  kind: "pr_open", source: prRef, pr_number: 42, head_branch: branch(it), head_sha, title: "t", body: "b", author: alice, labels: [],
});
const verdictOnPr = (it: WorkItem, args: string, comment_id: string): SourceEvent => ({
  kind: "verdict_submitted", target: { kind: "pr", pr_number: 42, head_branch: branch(it) }, comment_id, approver: alice, args,
});
const verdicts = async (f: F, it: WorkItem) =>
  (await f.store.listVerdicts(it.id)).map((v) => ({ verdict: v.verdict, severity: v.severity, implicit: v.implicit, pr_head: v.pr_head }));
const implicitRows = async (f: F, it: WorkItem) => (await f.store.listStateChanges(it.id)).filter((c) => c.reason === "implicit_verdict");

describe("implicit verdict on a merge", () => {
  it("one implicit accept, severity none, for the merged head, with the merger as actor; a second run adds nothing", async () => {
    const f = await setup();
    const it0 = await item(f);
    await f.controller.handleEvent(merged(it0));
    await f.controller.handleEvent(merged(it0));

    expect(await verdicts(f, it0)).toEqual([{ verdict: "accept", severity: "none", implicit: true, pr_head: "h1" }]);
    const rows = await implicitRows(f, it0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: { kind: "user", id: "github:1" }, changes: {} });
    const after = (await f.store.getWorkItem(it0.id))!;
    // The verdict's version bump, then the merge's own transition; the verdict changes no stage or blocked field.
    expect((await f.store.listStateChanges(it0.id)).slice(-2).map((c) => [c.reason, c.changes])).toEqual([
      ["implicit_verdict", {}],
      ["pr_merged", expect.objectContaining({ stage: { from: "REVIEW", to: "CLOSED" } })],
    ]);
    expect(after).toMatchObject({ stage: "CLOSED", close_reason: "completed", blocked_on: "none", blocked_reason: null, version: it0.version + 2 });
    expect(rows[0]!.version).toBe(it0.version + 1);
  });

  it("a merger that does not resolve to a user, or no merger: no implicit verdict, and the log says why", async () => {
    for (const merger of [stranger, null]) {
      const f = await setup();
      const it0 = await item(f);
      await f.controller.handleEvent(merged(it0, merger));
      expect(await f.store.getWorkItem(it0.id)).toMatchObject({ stage: "CLOSED", close_reason: "completed" });
      expect(await f.store.listVerdicts(it0.id)).toEqual([]);
      expect(f.log.lines.some((l) => l.level === "warn" && l.msg.includes("merger does not resolve"))).toBe(true);
    }
  });

  it("an adopted PR's merge records none (it is a person's PR)", async () => {
    const f = await setup();
    const it0 = await item(f, true);
    await f.controller.handleEvent(merged(it0));
    expect(await f.store.getWorkItem(it0.id)).toMatchObject({ stage: "CLOSED", close_reason: "completed" });
    expect(await f.store.listVerdicts(it0.id)).toEqual([]);
  });
});

describe("implicit verdict on a person's push", () => {
  it("one implicit changes for the new head, naming the commit count; it changes no stage or blocked field", async () => {
    const f = await setup();
    const it0 = await item(f);
    f.forge.commitAuthors.h2 = alice;
    f.forge.commitCounts["h1..h2"] = 2;
    await f.controller.handleEvent(pushed(it0, "h2"));
    await f.controller.handleEvent(pushed(it0, "h2"));

    expect(await f.store.listVerdicts(it0.id)).toEqual([
      expect.objectContaining({ verdict: "changes", severity: "minor", implicit: true, pr_head: "h2", reason: "a person pushed 2 commits to the PR" }),
    ]);
    expect(f.forge.betweenCalls).toEqual(["h1..h2"]);
    const after = (await f.store.getWorkItem(it0.id))!;
    expect(after).toMatchObject({ stage: it0.stage, blocked_on: it0.blocked_on, blocked_reason: it0.blocked_reason, version: it0.version + 1 });
    expect(await implicitRows(f, it0)).toEqual([expect.objectContaining({ version: after.version, actor: { kind: "user", id: "github:1" } })]);
  });

  it("then merged: the head keeps its changes verdict and gets no accept", async () => {
    const f = await setup();
    const it0 = await item(f);
    await f.controller.handleEvent(pushed(it0, "h2"));
    await f.controller.handleEvent(merged(it0));
    expect(await verdicts(f, it0)).toEqual([{ verdict: "changes", severity: "minor", implicit: true, pr_head: "h2" }]);
    expect(f.log.lines.some((l) => l.msg.includes("no implicit accept: a person pushed"))).toBe(true);
  });
});

describe("an explicit /verdict on a PR head", () => {
  it("replaces that head's implicit verdict, so one verdict remains for the head", async () => {
    const f = await setup();
    const it0 = await item(f);
    await f.controller.handleEvent(merged(it0));
    await f.controller.handleEvent(verdictOnPr(it0, "changes major the flag is misnamed", "600"));

    expect(await verdicts(f, it0)).toEqual([{ verdict: "changes", severity: "major", implicit: false, pr_head: "h1" }]);
    // A later implicit verdict for that head adds nothing either.
    await f.controller.handleEvent(merged(it0));
    expect(await f.store.listVerdicts(it0.id)).toHaveLength(1);
    expect(f.source.comments).toEqual([]);
  });
});

describe("implicit verdict on a revert", () => {
  const revert = (sha: string): SourceEvent => ({ kind: "base_commit", sha, message: `Revert "the change"\n\nThis reverts commit ${MERGE_SHA}.` });

  it("one implicit reverted verdict per reverting commit of a merged factory PR; a redelivery adds nothing", async () => {
    const f = await setup();
    const it0 = await item(f);
    await f.controller.handleEvent(merged(it0));
    for (const sha of ["r1", "r1", "r2"]) await f.controller.handleEvent(revert(sha));

    const reverted = (await f.store.listVerdicts(it0.id)).filter((v) => v.verdict === "reverted");
    expect(reverted.map((v) => [v.implicit, v.pr_head, v.reason])).toEqual([
      [true, null, "reverted by commit r1"],
      [true, null, "reverted by commit r2"],
    ]);
    expect(await f.store.getWorkItem(it0.id)).toMatchObject({ stage: "CLOSED", close_reason: "completed", blocked_on: "none", blocked_reason: null });
    // The merge's accept and the two reverts: one implicit_verdict row each.
    expect(await implicitRows(f, it0)).toHaveLength(3);
  });
});

describe("SQLite migration 38 and MySQL step 38: implicit verdicts", () => {
  it("SQLite: adds implicit (0 on older rows) and pr_head (NULL) to an existing database's verdicts", async () => {
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(STEP);
    const raw = new DatabaseSync(":memory:");
    for (const m of MIGRATIONS.slice(0, STEP - 1)) raw.exec(m);
    raw.exec("PRAGMA foreign_keys = OFF");
    raw.exec("INSERT INTO verdicts (id, work_item_id, state_change_id, verdict, severity, reason, comment_id, target, at) VALUES ('vd_1', 'wi_1', 'sc_1', 'accept', 'none', NULL, 'c1', 'pr', 't')");
    raw.exec(MIGRATIONS[STEP - 1]!);
    expect(raw.prepare("SELECT id, implicit, pr_head FROM verdicts").all().map((r) => ({ ...r }))).toEqual([{ id: "vd_1", implicit: 0, pr_head: null }]);
    raw.close();
    const store = new SqlFactoryStore(new SqliteDriver(":memory:"), new FakeClock());
    await store.migrate();
    await store.close();
  });

  it("MySQL: one ALTER right after step 37 with the same columns as SQLite migration 38, and a wider comment_id", () => {
    expect(readSteps(STEPS_DIR, INLINE_STEPS).find((s) => s.name === "implicit-verdicts")).toMatchObject({
      number: STEP, from: STEP - 1, kind: "sql", file: STEP_FILE,
    });
    const sql = readFileSync(join(STEPS_DIR, STEP_FILE), "utf8");
    expect(sql.split("\n").filter((l) => l.trim() !== "" && !l.startsWith("--"))).toHaveLength(1);
    for (const c of ["ADD COLUMN implicit ", "ADD COLUMN pr_head ", "MODIFY comment_id VARCHAR(128)", "ADD INDEX verdicts_head (work_item_id, pr_head)"]) {
      expect(sql).toContain(c);
    }
    for (const c of ["ADD COLUMN implicit ", "ADD COLUMN pr_head ", "verdicts_head ON verdicts (work_item_id, pr_head)"]) {
      expect(MIGRATIONS[STEP - 1]).toContain(c);
    }
  });
});
