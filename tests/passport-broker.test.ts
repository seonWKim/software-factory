import { describe, expect, it } from "vitest";
import { LocalAuthProvider, NotAuthenticated, PassportService, REVOCATIONS_TICK, localKeyFile, secretKeyring } from "../src/identity/index.js";
import { AuditedAuthProvider, controllerServiceAuth } from "../src/impl/auth/audited-auth.js";
import { PassportToolBroker, type HeldRunPassport } from "../src/impl/broker/passport-broker.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
import type { AuthProvider } from "../src/interfaces/auth-provider.js";
import type { ToolBroker, ToolCallContext } from "../src/interfaces/tool-broker.js";
import type { RunId, WorkItemId } from "../src/core/types.js";
import { ManualTickGenerator } from "../src/shared/ticks/plugins/manual/manual-tick-generator.js";
import { RunPassports } from "../src/worker/passports/run-passports.js";
import { mkdtemp, readdir, readFile, stat } from "node:fs/promises";
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
  const begin = (run = "run_1", kind = "implement", lease_token = 1) =>
    runs.begin({ run, lease_token, kind, item: "wi_1", project: "proj", branch: "factory/wi_1", grants: [] });
  const audit = () => db.all("SELECT principal, action, decision, reason FROM authz_audit ORDER BY seq");
  return { db, ticks, identity, runs, broker, calls, ctx, begin, audit, setHeld: (f: typeof held) => (held = f) };
}

describe("ToolBroker run passports", () => {
  it("passes a call the run passport names, narrowed from the worker's service passport, and audits it", async () => {
    const t = await setup();
    const issued = await t.begin();
    expect(issued.passport).toMatchObject({ principal: "service:worker", provider: "service", kind: "run", origin: "run" });
    expect(await t.broker.call(t.ctx(), "git.store_branch", { branch: "factory/wi_1" })).toEqual({ ok: true, content: "git.store_branch" });
    expect(await t.broker.call(t.ctx(), "github.preflight", { number: 1, body: "x" })).toMatchObject({ ok: true });
    expect(t.calls).toEqual(["git.store_branch", "github.preflight"]);
    expect(await t.audit()).toEqual([
      { principal: "service:worker", action: "use_tool", decision: "allow", reason: "allowed" },
      { principal: "service:worker", action: "use_tool", decision: "allow", reason: "allowed" },
    ]);
  });

  it("lets a stopped implement run keep its commits on its own wip branch, and no other wip branch", async () => {
    const t = await setup();
    await t.runs.begin({ run: "run_1", lease_token: 1, kind: "implement", item: "wi_1", project: "proj", branch: "factory/wi_1", wip_branch: "factory/wip/wi_1/run_1", grants: [] });
    expect(await t.broker.call(t.ctx(), "git.store_branch", { branch: "factory/wip/wi_1/run_1" })).toMatchObject({ ok: true });
    expect(await t.broker.call(t.ctx(), "git.store_branch", { branch: "factory/wip/wi_1/run_9" })).toMatchObject({
      ok: false, message: "git.store_branch: outside_branches",
    });
    expect(t.calls).toEqual(["git.store_branch"]);
  });

  it("refuses a run with no passport, a tool or branch outside it, and a token used for another run", async () => {
    const t = await setup();
    expect(await t.broker.call(t.ctx(), "git.store_branch", { branch: "factory/wi_1" })).toMatchObject({ ok: false, error_code: "passport_missing" });
    await t.begin("run_1", "review");
    expect(await t.broker.call(t.ctx(), "git.store_branch", { branch: "factory/wi_1" })).toMatchObject({ ok: false, error_code: "passport_denied", message: "git.store_branch: outside_tools" });
    await t.begin("run_2", "implement");
    expect(await t.broker.call(t.ctx("run_2"), "git.store_branch", { branch: "main" })).toMatchObject({ ok: false, message: "git.store_branch: outside_branches" });
    // run_1's token presented for run_2 (a widened passport): the runs caveat refuses it.
    t.setHeld(() => t.runs.passportOf("run_1"));
    expect(await t.broker.call(t.ctx("run_2"), "github.preflight", {})).toMatchObject({ ok: false, message: "github.preflight: outside_runs" });
    expect(t.calls).toEqual([]);
  });

  it("refuses from the next check once the run passport or its worker passport is revoked", async () => {
    const t = await setup();
    const run = await t.begin();
    expect(await t.broker.call(t.ctx(), "github.preflight", {})).toMatchObject({ ok: true });
    await t.identity.revoke(run.passport.id, "local:owner", "test");
    expect(await t.broker.call(t.ctx(), "github.preflight", {})).toMatchObject({ ok: false, message: "github.preflight: revoked" });

    await t.begin("run_2");
    await t.identity.revoke(run.passport.parent_id!, "local:owner", "worker passport leaked");
    expect(await t.broker.call(t.ctx("run_2"), "github.preflight", {})).toMatchObject({ ok: false, message: "github.preflight: revoked" });
    // The next run gets a fresh worker passport.
    const next = await t.begin("run_3");
    expect(next.passport.parent_id).not.toBe(run.passport.parent_id);
    expect(await t.broker.call(t.ctx("run_3"), "github.preflight", {})).toMatchObject({ ok: true });
    expect(t.calls).toEqual(["github.preflight", "github.preflight"]);
  });

  it("reaches another replica's broker on its next revocations tick", async () => {
    const t = await setup();
    const otherTicks = new ManualTickGenerator();
    const replica = new PassportService({ db: t.db, keys: secretKeyring(KEY, { current: "K" }), providers: [], grants: [], ticks: otherTicks, newId: () => "pp_replica" });
    await otherTicks.tick(REVOCATIONS_TICK, T0);
    const run = await t.begin();
    await replica.revoke(run.passport.id, "local:owner", "from another replica");
    expect(await t.broker.call(t.ctx(), "github.preflight", {})).toMatchObject({ ok: true });
    await t.ticks.tick(REVOCATIONS_TICK, T0 + 10_000);
    expect(await t.broker.call(t.ctx(), "github.preflight", {})).toMatchObject({ ok: false, message: "github.preflight: revoked" });
  });

  it("forgets a run's token when the run ends", async () => {
    const t = await setup();
    await t.begin();
    t.runs.end("run_1", 1);
    expect(await t.broker.call(t.ctx(), "github.preflight", {})).toMatchObject({ ok: false, error_code: "passport_missing" });
  });

  it("a slot that lost the run does not end the passport of the claim that took it over", async () => {
    const t = await setup();
    await t.begin("run_1", "implement", 1);
    // The run was requeued and claimed again in this process (token 2) before the first slot's finally ran.
    await t.begin("run_1", "implement", 2);
    t.runs.end("run_1", 1);
    expect(await t.broker.call(t.ctx(), "github.preflight", {})).toMatchObject({ ok: true });
    t.runs.end("run_1", 2);
    expect(await t.broker.call(t.ctx(), "github.preflight", {})).toMatchObject({ ok: false, error_code: "passport_missing" });
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

  it("with the command's passport, Identity checks it first and the plugin's grants decide the role, audited under it", async () => {
    const db = new SqliteDriver(":memory:");
    await db.migrate();
    const ticks = new ManualTickGenerator();
    let n = 0;
    const identity = new PassportService({
      db, keys: secretKeyring(KEY, { current: "K" }), providers: [new LocalAuthProvider()], grants: [], ticks, newId: () => `pp_${++n}`,
    });
    await ticks.tick(REVOCATIONS_TICK, T0);
    const allowAll: AuthProvider = { resolve: async () => null, authorize: async () => ({ allow: true }) };
    const auth = new AuditedAuthProvider(allowAll, identity);
    const ada = (await identity.authenticate({ provider: "local", subject: "ada" }, "cli")).passport.id;
    const bob = (await identity.authenticate({ provider: "local", subject: "bob" }, "cli")).passport.id;
    const who = { user_id: "local:ada" as never, attributes: {} };
    const item = { kind: "work_item" as const, id: "wi_1" };
    const at = (ms: number) => new Date(T0 + ms).toISOString();
    expect(await auth.authorize(who, "approve_spec", item, { id: ada, at: at(0) })).toEqual({ allow: true });
    // Another person's passport, or a revoked one, refuses although the plugin would allow.
    expect(await auth.authorize(who, "approve_spec", item, { id: bob, at: at(0) })).toEqual({ allow: false, reason: "passport_principal_mismatch" });
    // Two hours on (the passport lasts one): a command recorded while it was valid, which waited behind a failing
    // command, is still decided under it; one recorded after it expired is not.
    await ticks.tick(REVOCATIONS_TICK, T0 + 2 * 3_600_000);
    expect(await auth.authorize(who, "approve_spec", item, { id: ada, at: at(60_000) })).toEqual({ allow: true });
    expect(await auth.authorize(who, "approve_spec", item, { id: ada, at: at(2 * 3_600_000) })).toEqual({ allow: false, reason: "expired" });
    await identity.revoke(ada, "local:owner", "lost laptop");
    expect(await auth.authorize(who, "approve_spec", item, { id: ada, at: at(60_000) })).toEqual({ allow: false, reason: "revoked" });
    expect(await db.all("SELECT passport_id, principal, decision, reason FROM authz_audit ORDER BY seq")).toEqual([
      { passport_id: ada, principal: "local:ada", decision: "allow", reason: "allowed" },
      { passport_id: bob, principal: "local:bob", decision: "deny", reason: "passport_principal_mismatch" },
      { passport_id: ada, principal: "local:ada", decision: "allow", reason: "allowed" },
      { passport_id: ada, principal: "local:ada", decision: "deny", reason: "expired" },
      { passport_id: ada, principal: "local:ada", decision: "deny", reason: "revoked" },
    ]);
  });

  it("the controller's automatic steps act under its service passport, limited to its actions", async () => {
    const { identity, db } = await setup();
    const service = controllerServiceAuth(identity);
    expect(await service("approve_merge", { project: "proj", item: "wi_1" })).toEqual({ allow: true });
    expect(await service("record_verdict", { project: "proj", item: "wi_1" })).toEqual({ allow: false, reason: "outside_actions" });
    expect(await db.all("SELECT principal, action, decision FROM authz_audit ORDER BY seq")).toEqual([
      { principal: "service:controller", action: "approve_merge", decision: "allow" },
      { principal: "service:controller", action: "record_verdict", decision: "deny" },
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

  it("processes that start together on a fresh state folder all read the same whole key", async () => {
    // Create-then-write let a loser read an empty file (timing-dependent, not forced here); every start agrees on one
    // key and the temporary files are gone.
    const dir = await mkdtemp(join(tmpdir(), "sf-key-"));
    const path = join(dir, "passport.key");
    const keys = await Promise.all(Array.from({ length: 8 }, () => localKeyFile(path, "K").get("K")));
    expect(new Set(keys.map((k) => k!.reveal())).size).toBe(1);
    expect(keys[0]!.reveal()).toMatch(/^[0-9a-f]{64}$/);
    expect(await readdir(dir)).toEqual(["passport.key"]);
  });
});
