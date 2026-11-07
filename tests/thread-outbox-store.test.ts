import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SourceRef, UserId, WorkItemId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { INLINE_STEPS, MysqlMigrations, type Queryable, STEPS_DIR, readSteps } from "../src/impl/store/mysql/migrations.js";
import { SqlFactoryStore } from "../src/impl/store/sql/sql-factory-store.js";
import { MIGRATIONS } from "../src/impl/store/sqlite/schema.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { BACKENDS, MYSQL_URL, issue, mysqlStepsUpTo, newEmptyMysqlDatabase, system } from "./helpers/store.js";

// The thread outbox (issue #282): SQLite migration 26 and MySQL step 0026 add `thread_outbox`, and copy pending app
// requests into `command_inbox`. Never pin a step as the newest: a later migration would fail these checks.
const STEP = 26;
const STEP_FILE = "0026-thread-outbox.sql";

const ref = (n: number): SourceRef => ({ type: "github_issue", id: `o/r#${n}`, link: `https://github.com/o/r/issues/${n}` });

async function item(store: FactoryStore, n: number): Promise<WorkItemId> {
  return (await store.createWorkItem(issue(n), system)).item.id;
}

async function entry(store: FactoryStore, id: WorkItemId, marker: string, opts: { link?: "spec_comment_url" | "failure_comment_url" } = {}) {
  const r = await store.recordItemMessage({
    work_item_id: id,
    marker,
    body: `body ${marker}`,
    delivery: { source_type: "github_issue", target: ref(1), link_field: opts.link ?? null },
  });
  return r;
}

for (const backend of BACKENDS) {
  describe(`thread outbox store (${backend.name})`, () => {
    it("an entry written with a delivery gets one pending outbox row; a repeat of its marker adds none", async () => {
      const { store } = await backend.make();
      const id = await item(store, 1);
      const first = await entry(store, id, "<!-- factory:a -->");
      expect(first.created).toBe(true);
      expect((await entry(store, id, "<!-- factory:a -->")).created).toBe(false);
      const rows = await store.listDeliveries(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        thread_seq: first.message.seq, source_type: "github_issue", target: ref(1), marker: "<!-- factory:a -->",
        body: "body <!-- factory:a -->", attempts: 0, delivered_at: null, url: null,
      });
      // No delivery: the thread is the only copy.
      await store.recordItemMessage({ work_item_id: id, marker: "<!-- factory:b -->", body: "b" });
      expect((await store.listDeliveries(id)).map((d) => d.marker)).toEqual(["<!-- factory:a -->"]);
    });

    it("pending rows are listed only for the given source types", async () => {
      const { store } = await backend.make();
      const id = await item(store, 1);
      await entry(store, id, "m1");
      expect((await store.listPendingDeliveries(["github_issue"], 10)).map((d) => d.marker)).toContain("m1");
      expect(await store.listPendingDeliveries(["slack_thread"], 10)).toEqual([]);
      expect(await store.listPendingDeliveries([], 10)).toEqual([]);
    });

    it("a claim is exclusive until it expires; finish under the claim marks it delivered and lists it no more", async () => {
      const { store, clock } = await backend.make();
      const id = await item(store, 1);
      await entry(store, id, "m1");
      const seq = (await store.listDeliveries(id))[0]!.seq;
      const token = await store.claimDelivery(seq, 60_000);
      expect(token).not.toBeNull();
      expect(await store.claimDelivery(seq, 60_000)).toBeNull();
      expect(await store.listPendingDeliveries(["github_issue"], 10)).toEqual([]);
      clock.advance(60_001);
      const second = await store.claimDelivery(seq, 60_000);
      expect(second).not.toBeNull();
      // The first claim is fenced out once a second one took the row.
      expect(await store.finishDelivery(seq, token!, "u1")).toBe(false);
      expect(await store.finishDelivery(seq, second!, "u2")).toBe(true);
      expect(await store.finishDelivery(seq, second!, "u3")).toBe(false);
      expect((await store.listDeliveries(id))[0]).toMatchObject({ url: "u2", delivered_at: clock.now().toISOString() });
      expect(await store.claimDelivery(seq, 60_000)).toBeNull();
      expect(await store.listPendingDeliveries(["github_issue"], 10)).toEqual([]);
    });

    it("a failure counts an attempt, keeps the error and waits until the retry time; the item is unchanged", async () => {
      const { store, clock } = await backend.make();
      const id = await item(store, 1);
      await entry(store, id, "m1");
      const before = (await store.getWorkItem(id))!;
      const seq = (await store.listDeliveries(id))[0]!.seq;
      const token = (await store.claimDelivery(seq, 60_000))!;
      expect(await store.failDelivery(seq, token, "boom", 5_000)).toBe(true);
      expect(await store.failDelivery(seq, token, "again", 5_000)).toBe(false);
      expect((await store.listDeliveries(id))[0]).toMatchObject({ attempts: 1, last_error: "boom", delivered_at: null });
      expect(await store.listPendingDeliveries(["github_issue"], 10)).toEqual([]);
      clock.advance(5_000);
      expect((await store.listPendingDeliveries(["github_issue"], 10)).map((d) => d.seq)).toEqual([seq]);
      const after = (await store.getWorkItem(id))!;
      expect(after).toEqual(before);
    });

    it("a delivered link fills the item's field without a version change; an older entry never hides a newer one", async () => {
      const { store } = await backend.make();
      const id = await item(store, 1);
      await entry(store, id, "old", { link: "failure_comment_url" });
      await entry(store, id, "new", { link: "failure_comment_url" });
      await entry(store, id, "spec", { link: "spec_comment_url" });
      const [oldRow, newRow, specRow] = await store.listDeliveries(id);
      const version = (await store.getWorkItem(id))!.version;
      const deliver = async (seq: number, url: string) => store.finishDelivery(seq, (await store.claimDelivery(seq, 1000))!, url);
      await deliver(newRow!.seq, "u-new");
      await deliver(oldRow!.seq, "u-old");
      await deliver(specRow!.seq, "u-spec");
      expect(await store.getWorkItem(id)).toMatchObject({ failure_comment_url: "u-new", spec_comment_url: "u-spec", version });
    });

    it("an app request also lands in the command inbox, keyed on its seq", async () => {
      const { store } = await backend.make();
      const { request } = await store.recordAppCommandRequest({ key: "k1", actor: "github:1" as UserId, command: "approve", args: { work_item_id: "x" } });
      await store.recordAppCommandRequest({ key: "k1", actor: "github:1" as UserId, command: "approve", args: {} });
      const inbox = (await store.listCliCommandsAfter(0, 100)).filter((c) => c.args.app_request === request.seq);
      expect(inbox).toEqual([expect.objectContaining({ key: `app:${request.seq}`, actor: "github:1", command: "approve" })]);
    });
  });
}

describe("SQLite migration 26: thread outbox", () => {
  it("is in the migration list and creates thread_outbox; pending app requests are copied into the inbox once", async () => {
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(STEP);
    expect(MIGRATIONS[STEP - 1]).toContain("CREATE TABLE IF NOT EXISTS thread_outbox (");
    const driver = new SqliteDriver(":memory:");
    const store = new SqlFactoryStore(driver, new FakeClock());
    await store.migrate();
    // Back to 25: no outbox, and requests written before the inbox copy existed.
    await driver.run("DROP TABLE thread_outbox");
    await driver.run("DELETE FROM schema_migrations WHERE version > ?", [STEP - 1]);
    const req = "INSERT INTO app_command_requests (request_key, actor, command, args, created_at, handled_at) VALUES (?, ?, ?, ?, ?, ?)";
    await driver.run(req, ["p1", "github:1", "approve", "{}", "2026-01-01T00:00:00.000Z", null]);
    await driver.run(req, ["h1", "github:1", "approve", "{}", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:01.000Z"]);
    await store.migrate();
    await driver.run("DELETE FROM schema_migrations WHERE version > ?", [STEP - 1]);
    await store.migrate();
    expect(await driver.schemaVersion()).toEqual({ applied: MIGRATIONS.length, latest: MIGRATIONS.length });
    const copied = (await store.listCliCommandsAfter(0, 100)).filter((c) => typeof c.args.app_request === "number");
    expect(copied.map((c) => c.command)).toEqual(["approve"]);
    expect(copied[0]!.key).toBe(`app:${copied[0]!.args.app_request}`);
    expect(await driver.all("SELECT * FROM thread_outbox")).toEqual([]);
    await store.close();
  });
});

describe("MySQL step 0026: thread outbox", () => {
  const sql = () => readFileSync(join(STEPS_DIR, STEP_FILE), "utf8");
  const columns = (text: string) => {
    const body = /CREATE TABLE IF NOT EXISTS thread_outbox \(([\s\S]*?)\n\s*\)/.exec(text)![1]!;
    return [...body.matchAll(/^\s+([a-z_]+)\s+(?:TEXT|INTEGER|VARCHAR|BIGINT|MEDIUMTEXT|CHAR|INT)\b/gm)].map((m) => m[1]);
  };

  it("is a .sql step after 0025 that creates the same columns as SQLite migration 26", () => {
    const steps = readSteps(STEPS_DIR, INLINE_STEPS);
    expect(steps.find((s) => s.name === "thread-outbox")).toMatchObject({ number: STEP, from: STEP - 1, kind: "sql", file: STEP_FILE });
    expect(columns(sql())).toEqual(columns(MIGRATIONS[STEP - 1]!));
    expect(columns(sql())).toContain("claim_token");
  });
});

describe.skipIf(!MYSQL_URL)("MySQL step 0026 on MySQL", () => {
  it("from state 25 it creates thread_outbox and copies pending app requests once, also when run again", async () => {
    const db = await newEmptyMysqlDatabase();
    const c: Queryable = await db.connect();
    await new MysqlMigrations(c, { dir: mysqlStepsUpTo(STEP - 1) }).apply(() => undefined);
    const req = "INSERT INTO app_command_requests (request_key, actor, command, args, created_at, handled_at) VALUES (?, ?, ?, ?, ?, ?)";
    await c.query(req, ["p1", "github:1", "approve", "{}", "2026-01-01T00:00:00.000Z", null]);
    await c.query(req, ["h1", "github:1", "approve", "{}", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:01.000Z"]);
    await new MysqlMigrations(c, { dir: mysqlStepsUpTo(STEP) }).apply(() => undefined);
    await c.query("UPDATE schema_state SET state = ? WHERE id = 1", [STEP - 1]);
    await new MysqlMigrations(c, { dir: mysqlStepsUpTo(STEP) }).apply(() => undefined);
    const [rows] = await c.query("SELECT command_key, args FROM command_inbox WHERE command_key LIKE 'app:%'");
    const list = rows as { command_key: string; args: string }[];
    expect(list).toHaveLength(1);
    expect(JSON.parse(list[0]!.args)).toEqual({ app_request: expect.any(Number) });
    const [outbox] = await c.query("SELECT COUNT(*) AS n FROM thread_outbox");
    expect(Number((outbox as { n: number }[])[0]!.n)).toBe(0);
  });
});
