// The Data page's Ask (design 09-dashboard-app): POST /api/v1/data/ask behind the write guards and the owner check,
// a fake LLMProvider that records its request and answers with a query, and the read-only query on a SQLite file
// store. Everything goes through respond(), without a socket.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LogFields, Logger } from "../src/core/log.js";
import type { UserId, WorkerId } from "../src/core/types.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import type { LLMProvider, LLMRequest, LLMResponse } from "../src/interfaces/llm-provider.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { SqlFactoryStore } from "../src/impl/store/sql/sql-factory-store.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
import { READ_ONLY_MAX_ROWS } from "../src/impl/store/sqlite/readonly-query.js";
import { DATA_ASK_PATH, QUESTION_MAX } from "../src/ui/data-ask.js";
import { HealthMonitor } from "../src/ui/health.js";
import type { UiPauses } from "../src/ui/pause-api.js";
import { type ApiDeps, respond } from "../src/ui/server.js";
import type { UiSettings } from "../src/ui/settings-api.js";
import { issue, system } from "./helpers/store.js";

const HOST = "127.0.0.1:4310";
const ORIGIN = `http://${HOST}`;
const TOKEN = "csrf-token-for-tests";
const OWNER = "local:owner@example.com" as UserId;
const NOW = new Date("2026-11-14T09:30:00.000Z");
// Built here so no secret-shaped literal sits in the repository.
const SECRET = `ghp_${"Ab3".repeat(12)}`;
// Row values no schema line, date or instruction can hold by chance.
const TITLE = "Zebra-quartz-7731 title";
const PROBLEM = "Marmalade-orbit-5520 problem";
const LEASE_TOKEN = 8264019375521;
const QUESTION = "how many implement runs failed today";

class MemLog implements Logger {
  records: { msg: string; fields: LogFields }[] = [];
  info(msg: string, fields: LogFields = {}) {
    this.records.push({ msg, fields });
  }
  warn(msg: string, fields?: LogFields) {
    this.info(msg, fields);
  }
  error(msg: string, fields?: LogFields) {
    this.info(msg, fields);
  }
}

/** A model that records each request and answers with the next query (or throws, or gives `answer` as is). */
class FakeModel implements LLMProvider {
  requests: LLMRequest[] = [];
  constructor(private readonly answer: string | Error | Partial<LLMResponse>) {}
  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.requests.push(req);
    if (this.answer instanceof Error) throw this.answer;
    const usage = { input_tokens: 1200, output_tokens: 40, cost_usd: 0.0123 };
    if (typeof this.answer === "string") return { text: JSON.stringify({ sql: this.answer }), parsed: { sql: this.answer }, stop_reason: "end", usage };
    return { text: "", stop_reason: "end", usage, ...this.answer };
  }
}

const open: FactoryStore[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.close();
});

async function page(o: { model?: string | Error | Partial<LLMResponse> | null; as?: UserId; store?: (s: FactoryStore) => FactoryStore } = {}) {
  const clock = new FakeClock(NOW);
  const driver = new SqliteDriver(join(mkdtempSync(join(tmpdir(), "sf-data-ask-")), "factory.db"));
  const raw = new SqlFactoryStore(driver, clock);
  await raw.migrate();
  open.push(raw);
  await raw.claimOwner(OWNER);
  const item = (await raw.createWorkItem({ ...issue(1), title: TITLE, problem: PROBLEM }, system)).item;
  await raw.createWorkItem({ ...issue(2), title: `Leaky ${SECRET}` }, system);
  const t = await raw.transition({ id: item.id, expected_version: item.version, patch: {}, actor: system, reason: "x", enqueue: { kind: "implement", idempotency_key: "i:1" } });
  if (!t.ok) throw new Error(t.reason);
  const run = (await raw.claimRun({ worker_id: "host:1:0" as WorkerId, kinds: ["implement"], lease_ms: 60_000 }))!;
  await driver.run("UPDATE worker_runs SET status = 'failed', finished_at = ?, lease_token = ? WHERE id = ?", ["2026-11-14T08:00:00.000Z", LEASE_TOKEN, run.id]);

  const model = o.model === null ? null : new FakeModel(o.model ?? "SELECT 1 AS one");
  const log = new MemLog();
  const settings: UiSettings = {
    base: { file: {}, layers: { defaults: {}, projects: {} }, max_workers: 8 } as unknown as UiSettings["base"],
    repo: { owner: "o", name: "r" }, actor: OWNER, resolveProject: async () => null, csrfToken: TOKEN,
    ask: { llm: model, log },
  };
  const pauses: UiPauses = { principal: async () => o.as ?? OWNER, authorize: async () => ({ allow: true }), csrfToken: TOKEN, log };
  const store = o.store ? o.store(raw) : raw;
  const d: ApiDeps = {
    store, clock, lease_ms: 60_000, settings, pauses,
    scanner: new PatternEgressScanner(async () => []),
    health: new HealthMonitor(async () => [], clock),
  };
  const post = async (body: unknown, over: Record<string, unknown> = {}) => {
    const r = await respond(d, { method: "POST", url: DATA_ASK_PATH, host: HOST, origin: ORIGIN, contentType: "application/json", csrfToken: TOKEN, body: JSON.stringify(body), ...over });
    return { status: r.status, value: JSON.parse(r.body) as Record<string, unknown> };
  };
  const get = async (path: string) => {
    const r = await respond(d, { method: "GET", url: path, host: HOST });
    return { status: r.status, value: JSON.parse(r.body) as Record<string, unknown> };
  };
  return { d, model, log, post, get, driver, run };
}

/** A store whose readOnlyQuery calls are counted. */
function counted(calls: string[]) {
  return (s: FactoryStore): FactoryStore =>
    new Proxy(s, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver) as unknown;
        if (prop !== "readOnlyQuery" || typeof v !== "function") return v;
        return (...args: unknown[]) => (calls.push(String(args[0])), (v as (...a: unknown[]) => unknown)(...args));
      },
    });
}

describe("POST /api/v1/data/ask: guards", () => {
  it("runs Host, Origin, Content-Type, CSRF token, body size, then the owner check, each before any model call", async () => {
    const p = await page();
    const body = { question: QUESTION };
    expect((await p.post(body, { host: "evil.example" })).status).toBe(403);
    expect((await p.post(body, { origin: "http://evil.example" })).status).toBe(403);
    expect((await p.post(body, { contentType: "text/plain" })).status).toBe(415);
    expect((await p.post(body, { csrfToken: "stale" })).status).toBe(403);
    expect((await p.post(body, { bodyTooLarge: true })).status).toBe(413);
    expect(p.model!.requests).toEqual([]);
    const other = await page({ as: "local:someone@example.com" as UserId });
    const refused = await other.post(body);
    expect(refused.status).toBe(403);
    expect(String(refused.value.error)).toContain("Only the owner asks the data");
    expect(other.model!.requests).toEqual([]);
  });

  it("takes a question of 1 to 1000 characters", async () => {
    const p = await page();
    for (const question of ["", "   ", "x".repeat(QUESTION_MAX + 1), 7, null]) {
      expect((await p.post({ question })).status, JSON.stringify(question)).toBe(400);
    }
    expect(p.model!.requests).toEqual([]);
    expect((await p.post({ question: "x".repeat(QUESTION_MAX) })).status).toBe(200);
  });

  it("is a 405 when the server has no Ask", async () => {
    const p = await page();
    delete p.d.settings!.ask;
    expect((await p.post({ question: QUESTION })).status).toBe(405);
    expect((await p.get("/api/v1/data/tables")).value.csrf_token).toBeNull();
  });
});

describe("POST /api/v1/data/ask: the model", () => {
  it("with no model: a message, no query runs, and the table list still loads with its descriptions", async () => {
    const calls: string[] = [];
    const p = await page({ model: null, store: counted(calls) });
    const r = await p.post({ question: QUESTION });
    expect(r.status).toBe(503);
    expect(String(r.value.error)).toMatch(/No model is configured/);
    expect(calls).toEqual([]);
    const tables = await p.get("/api/v1/data/tables");
    expect(tables.status).toBe(200);
    expect(tables.value.csrf_token).toBe(TOKEN);
    expect((tables.value.tables as { name: string; owner: string }[]).find((t) => t.name === "worker_runs")).toMatchObject({ owner: "worker", description: expect.any(String) });
  });

  it("when the model fails or gives no query: a message, and no query runs", async () => {
    for (const model of [new Error("model down"), { stop_reason: "error" as const }, { text: "not json" }]) {
      const calls: string[] = [];
      const p = await page({ model, store: counted(calls) });
      const r = await p.post({ question: QUESTION });
      expect(r.status, JSON.stringify(model)).toBe(502);
      expect(String(r.value.error)).toMatch(/no query ran/);
      expect(calls).toEqual([]);
    }
  });

  it("sends only the instruction, the question, today's UTC date and the schema with its lines: no row value, no hidden column", async () => {
    const p = await page();
    expect((await p.post({ question: QUESTION })).status).toBe(200);
    expect(p.model!.requests).toHaveLength(1);
    const req = p.model!.requests[0]!;
    expect(Object.keys(req).sort()).toEqual(["data_env", "max_tokens", "messages", "model_class", "output_schema", "signal", "system"]);
    expect(req.messages).toHaveLength(1);
    const content = req.messages[0]!.content;
    expect(content).toContain(`Question: ${QUESTION}`);
    expect(content).toContain("Today (UTC): 2026-11-14");
    expect(content).toMatch(/^worker_runs: Runs of work items/m);
    expect(content).toContain("kind (triage, implement");
    const sent = JSON.stringify(req);
    for (const value of [TITLE, PROBLEM, SECRET, String(LEASE_TOKEN), p.run.id, "host:1:0", "problem 2"]) expect(sent).not.toContain(value);
    for (const hidden of ["lease_token", "code_hash"]) expect(sent).not.toContain(hidden);
  });

  it("writes one cost record per model call, with its tokens and cost", async () => {
    const p = await page();
    await p.post({ question: QUESTION });
    await p.post({ question: "how many items are there" });
    const records = p.log.records.filter((r) => r.msg === "data ask: model call");
    expect(records).toHaveLength(p.model!.requests.length);
    expect(records[0]!.fields).toMatchObject({ model_class: "standard", input_tokens: 1200, output_tokens: 40, cost_usd: 0.0123 });
  });
});

describe("POST /api/v1/data/ask: the query", () => {
  it(`"${QUESTION}": shows the query, runs it read-only and answers the count in one line, with one model call`, async () => {
    const sql = "SELECT count(*) AS failed_today FROM worker_runs WHERE kind = 'implement' AND status = 'failed' AND substr(finished_at, 1, 10) = '2026-11-14'";
    const p = await page({ model: sql });
    const r = await p.post({ question: QUESTION });
    expect(r).toEqual({ status: 200, value: { as_of: NOW.toISOString(), sql, columns: ["failed_today"], rows: [[1]], truncated: false, answer: "failed_today: 1" } });
    expect(p.model!.requests).toHaveLength(1);
  });

  it("refuses a non-SELECT, a second statement, ATTACH and PRAGMA with the reason and the query", async () => {
    const cases: [string, RegExp][] = [
      ["DELETE FROM worker_runs", /Only a SELECT \(or WITH … SELECT\) runs/],
      ["SELECT 1; DELETE FROM worker_runs", /Only one statement runs/],
      ["ATTACH DATABASE 'x.db' AS x", /begins with ATTACH/],
      ["PRAGMA query_only = OFF", /begins with PRAGMA/],
    ];
    for (const [sql, reason] of cases) {
      const p = await page({ model: sql });
      const r = await p.post({ question: QUESTION });
      expect(r.status, sql).toBe(422);
      expect(r.value).toMatchObject({ sql, refused: expect.stringMatching(reason), error: expect.stringMatching(reason) });
      expect(r.value.rows).toBeUndefined();
    }
    const p = await page();
    expect(await p.driver.all("SELECT COUNT(*) AS n FROM worker_runs")).toEqual([{ n: 1 }]);
  });

  it("refuses a query that names a hidden column, and shows a hidden column's cells as [hidden]", async () => {
    const named = await page({ model: "SELECT id, \"lease_token\" FROM worker_runs" });
    const r = await named.post({ question: QUESTION });
    expect(r.status).toBe(422);
    expect(String(r.value.refused)).toMatch(/names lease_token, a hidden column/);
    const star = await page({ model: "SELECT * FROM worker_runs" });
    const all = await star.post({ question: QUESTION });
    expect(all.status).toBe(200);
    const columns = all.value.columns as string[];
    const row = (all.value.rows as unknown[][])[0]!;
    expect(row[columns.indexOf("lease_token")]).toBe("[hidden]");
    expect(JSON.stringify(all.value)).not.toContain(String(LEASE_TOKEN));
  });

  it(`returns at most ${READ_ONLY_MAX_ROWS} rows and says the result was cut`, async () => {
    const p = await page({ model: "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 700) SELECT x FROM n" });
    const r = await p.post({ question: "count to 700" });
    expect(r.status).toBe(200);
    expect(r.value.rows).toHaveLength(READ_ONLY_MAX_ROWS);
    expect(r.value.truncated).toBe(true);
    expect(r.value.answer).toBeNull();
  });

  it("passes every result cell through the Withholder", async () => {
    const p = await page({ model: "SELECT title FROM controller_work_items ORDER BY title" });
    const r = await p.post({ question: "the titles" });
    expect(r.status).toBe(200);
    const cells = (r.value.rows as unknown[][]).map((row) => row[0]);
    expect(cells).toContain(TITLE);
    expect(cells).toContainEqual(expect.stringMatching(/^\[withheld: [a-z_, ]+\]$/));
    expect(JSON.stringify(r.value)).not.toContain(SECRET);
  });
});
