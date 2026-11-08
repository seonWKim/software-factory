import { describe, expect, it } from "vitest";
import { NotAuthenticated, PassportService, REVOCATIONS_TICK, localKeyFile, secretKeyring } from "../src/identity/index.js";
import { AuditedAuthProvider } from "../src/impl/auth/audited-auth.js";
import { PassportToolBroker, type HeldRunPassport } from "../src/impl/broker/passport-broker.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
import type { AuthProvider } from "../src/interfaces/auth-provider.js";
import type { ToolBroker, ToolCallContext } from "../src/interfaces/tool-broker.js";
import type { RunId, WorkItemId } from "../src/core/types.js";
import { ManualTickGenerator } from "../src/shared/ticks/plugins/manual/manual-tick-generator.js";
import { RunPassports } from "../src/worker/passports/run-passports.js";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// RFC 0015 §8 "Tools" (M9): the ToolBroker checks the run passport on every call (G2). It refuses a run with no
// passport, a tool, run or branch the passport does not name, and a revoked passport from the next check on.

const T0 = Date.parse("2026-11-08T12:00:00.000Z");
const KEY = { get: async () => ({ reveal: () => "k".repeat(40) }) };

async function setup() {
  const db = new SqliteDriver(":memory:");
  await db.migrate();
  const ticks = new ManualTickGenerator();
  let n = 0;
  const identity = new PassportService({ db, keys: secretKeyring(KEY, { current: "K" }), providers: [], grants: [], ticks, newId: () => `pp_${++n}` });
  await ticks.tick(REVOCATIONS_TICK, T0);
  const calls: string[] = [];
  const inner: ToolBroker = {
    listTools: () => [],
    allTools: () => [],
    call: async (_ctx, name) => {
      calls.push(name);
      return { ok: true, content: name };
    },
  };
  const runs = new RunPassports(identity);
  let held: (run: string) => HeldRunPassport | null = (run) => runs.passportOf(run);
  const broker = new PassportToolBroker(inner, { checker: identity, passportOf: (run) => held(run) });
  const ctx = (run = "run_1", item = "wi_1"): ToolCallContext => ({ run_id: run as RunId, work_item_id: item as WorkItemId, lease_token: 1 });
  const begin = (run = "run_1", kind = "implement") =>
    runs.begin({ run, kind, item: "wi_1", project: "proj", branch: "factory/wi_1", grants: [] });
  const audit = () => db.all("SELECT principal, action, decision, reason FROM authz_audit ORDER BY seq");
  return { db, ticks, identity, runs, broker, calls, ctx, begin, audit, setHeld: (f: typeof held) => (held = f) };
}

describe("ToolBroker run passports", () => {
  it("passes a call the run passport names, narrowed from the worker's service passport, and audits it", async () => {
    const t = await setup();
    const issued = await t.begin();
    expect(issued.passport).toMatchObject({ principal: "service:worker", provider: "service", kind: "run", origin: "run" });
    expect(await t.broker.call(t.ctx(), "github.push_branch", { branch: "factory/wi_1" })).toEqual({ ok: true, content: "github.push_branch" });
    expect(await t.broker.call(t.ctx(), "github.open_pr", { number: 1, body: "x" })).toMatchObject({ ok: true });
    expect(t.calls).toEqual(["github.push_branch", "github.open_pr"]);
    expect(await t.audit()).toEqual([
      { principal: "service:worker", action: "use_tool", decision: "allow", reason: "allowed" },
      { principal: "service:worker", action: "use_tool", decision: "allow", reason: "allowed" },
    ]);
  });

  it("refuses a run with no passport, a tool or branch outside it, and a token used for another run", async () => {
    const t = await setup();
    expect(await t.broker.call(t.ctx(), "github.push_branch", { branch: "factory/wi_1" })).toMatchObject({ ok: false, error_code: "passport_missing" });
    await t.begin("run_1", "review");
    expect(await t.broker.call(t.ctx(), "github.push_branch", { branch: "factory/wi_1" })).toMatchObject({ ok: false, error_code: "passport_denied", message: "github.push_branch: outside_tools" });
    await t.begin("run_2", "implement");
    expect(await t.broker.call(t.ctx("run_2"), "github.push_branch", { branch: "main" })).toMatchObject({ ok: false, message: "github.push_branch: outside_branches" });
    // run_1's token presented for run_2 (a widened passport): the runs caveat refuses it.
    t.setHeld(() => t.runs.passportOf("run_1"));
    expect(await t.broker.call(t.ctx("run_2"), "github.open_pr", {})).toMatchObject({ ok: false, message: "github.open_pr: outside_runs" });
    expect(t.calls).toEqual([]);
  });

  it("refuses from the next check once the run passport or its worker passport is revoked", async () => {
    const t = await setup();
    const run = await t.begin();
    expect(await t.broker.call(t.ctx(), "github.open_pr", {})).toMatchObject({ ok: true });
    await t.identity.revoke(run.passport.id, "local:owner", "test");
    expect(await t.broker.call(t.ctx(), "github.open_pr", {})).toMatchObject({ ok: false, message: "github.open_pr: revoked" });

    await t.begin("run_2");
    await t.identity.revoke(run.passport.parent_id!, "local:owner", "worker passport leaked");
    expect(await t.broker.call(t.ctx("run_2"), "github.open_pr", {})).toMatchObject({ ok: false, message: "github.open_pr: revoked" });
    // The next run gets a fresh worker passport.
    const next = await t.begin("run_3");
    expect(next.passport.parent_id).not.toBe(run.passport.parent_id);
    expect(await t.broker.call(t.ctx("run_3"), "github.open_pr", {})).toMatchObject({ ok: true });
    expect(t.calls).toEqual(["github.open_pr", "github.open_pr"]);
  });

  it("reaches another replica's broker on its next revocations tick", async () => {
    const t = await setup();
    const otherTicks = new ManualTickGenerator();
    const replica = new PassportService({ db: t.db, keys: secretKeyring(KEY, { current: "K" }), providers: [], grants: [], ticks: otherTicks, newId: () => "pp_replica" });
    await otherTicks.tick(REVOCATIONS_TICK, T0);
    const run = await t.begin();
    await replica.revoke(run.passport.id, "local:owner", "from another replica");
    expect(await t.broker.call(t.ctx(), "github.open_pr", {})).toMatchObject({ ok: true });
    await t.ticks.tick(REVOCATIONS_TICK, T0 + 10_000);
    expect(await t.broker.call(t.ctx(), "github.open_pr", {})).toMatchObject({ ok: false, message: "github.open_pr: revoked" });
  });

  it("forgets a run's token when the run ends", async () => {
    const t = await setup();
    await t.begin();
    t.runs.end("run_1");
    expect(await t.broker.call(t.ctx(), "github.open_pr", {})).toMatchObject({ ok: false, error_code: "passport_missing" });
  });
});

describe("service passports", () => {
  it("only the service provider mints a service principal", async () => {
    const { identity } = await setup();
    await expect(identity.authenticate({ provider: "local", subject: "service:worker" }, "cli")).rejects.toThrow(NotAuthenticated);
    await expect(identity.authenticate({ provider: "service", subject: "mallory" }, "service")).rejects.toThrow(NotAuthenticated);
    const c = await identity.service("controller");
    expect(c.passport).toMatchObject({ principal: "service:controller", kind: "person", chain: [{ actions: ["approve_merge", "approve_spec"] }] });
    expect(await identity.service("controller")).toBe(c);
    expect(await identity.authorize(c.passport.id, "approve_merge", { project: "p" })).toMatchObject({ allow: true });
    expect(await identity.authorize(c.passport.id, "use_tool", { project: "p" })).toMatchObject({ allow: false, reason: "outside_actions" });
  });

  it("lasts 24h and is reissued at half-life, so a new run passport has at least 12h ahead", async () => {
    const { identity, ticks, begin } = await setup();
    const first = await identity.service("worker");
    expect(first.passport.expires_at).toBe("2026-11-09T12:00:00.000Z");
    await ticks.tick(REVOCATIONS_TICK, T0 + 11 * 3_600_000);
    expect(await identity.service("worker")).toBe(first);
    await ticks.tick(REVOCATIONS_TICK, T0 + 12 * 3_600_000);
    const run = await begin();
    expect(run.passport.parent_id).not.toBe(first.passport.id);
    expect(run.passport.expires_at).toBe("2026-11-10T00:00:00.000Z");
  });
});

describe("audited legacy auth", () => {
  it("keeps the plugin's decision and writes it to authz_audit", async () => {
    const { identity, audit } = await setup();
    const inner: AuthProvider = {
      resolve: async () => null,
      authorize: async (p, action) => (action === "submit_work" ? { allow: true } : { allow: false, reason: "no_role" }),
    };
    const auth = new AuditedAuthProvider(inner, identity);
    const who = { user_id: "local:ada" as never, attributes: {} };
    expect(await auth.authorize(who, "submit_work", { kind: "work_item", id: "wi_1" })).toEqual({ allow: true });
    expect(await auth.authorize(who, "approve_merge", { kind: "work_item", id: "wi_1" })).toEqual({ allow: false, reason: "no_role" });
    expect(await audit()).toEqual([
      { principal: "local:ada", action: "submit_work", decision: "allow", reason: "allowed" },
      { principal: "local:ada", action: "approve_merge", decision: "deny", reason: "no_role" },
    ]);
  });
});

describe("local passport key", () => {
  it("is made once with mode 0600 and read back by every process", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sf-key-"));
    const path = join(dir, "passport.key");
    const a = await localKeyFile(path, "K").get("K");
    const b = await localKeyFile(path, "K").get("K");
    expect(a!.reveal()).toMatch(/^[0-9a-f]{64}$/);
    expect(b!.reveal()).toBe(a!.reveal());
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await localKeyFile(path, "K").get("OTHER")).toBeNull();
    expect((await readFile(path, "utf8")).trim()).toBe(a!.reveal());
  });
});
