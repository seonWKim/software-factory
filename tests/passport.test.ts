import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  LocalAuthProvider,
  OwnerGrant,
  PassportService,
  REVOCATIONS_TICK,
  localIdentity,
  secretKeyring,
  type Action,
  type GrantSource,
  type ResourceRef,
  type SecretProvider,
} from "../src/identity/index.js";
import { makeLink, type Link } from "../src/identity/passport/token.js";
import { MysqlDriver } from "../src/impl/store/mysql/mysql-driver.js";
import { MysqlMigrations } from "../src/impl/store/mysql/migrations.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
import { ManualTickGenerator } from "../src/shared/ticks/plugins/manual/manual-tick-generator.js";
import type { SqlExecutor } from "../src/state/index.js";
import { MYSQL_URL, newEmptyMysqlDatabase } from "./helpers/store.js";

// RFC 0015 §8, §9 `passport`: issue and verify, tamper detection, narrowing never widens, revocation, expiry on
// Identity's tick (no clock), and an audit row for every decision. SQLite always; MySQL when SF_TEST_MYSQL_URL is set.

const T0 = Date.parse("2026-11-08T12:00:00.000Z");
const OWNER = "local:owner@example.com";
const KEY_A = "a".repeat(40);
const KEY_B = "b".repeat(40);

function secrets(values: Record<string, string>): SecretProvider {
  return { get: async (name) => (name in values ? { reveal: () => values[name]! } : null) };
}

async function sqlite(): Promise<SqlExecutor> {
  const d = new SqliteDriver(":memory:");
  await d.migrate();
  return d;
}

async function mysqlDb(): Promise<SqlExecutor> {
  const db = await newEmptyMysqlDatabase();
  await new MysqlMigrations(await db.connect()).apply(() => undefined);
  const driver = new MysqlDriver(db.options);
  db.onCleanup(() => driver.close());
  return driver;
}

let ids = 0;

const BACKENDS: [string, boolean, () => Promise<SqlExecutor>][] = [
  ["sqlite", true, sqlite],
  ["mysql", Boolean(MYSQL_URL), mysqlDb],
];

for (const [name, enabled, open] of BACKENDS) {
  describe.skipIf(!enabled)(`passport (${name})`, () => {
    async function setup(o: { keys?: Record<string, string>; previous?: string[]; grants?: GrantSource[]; db?: SqlExecutor } = {}) {
      const db = o.db ?? (await open());
      const ticks = new ManualTickGenerator();
      const svc = new PassportService({
        db,
        keys: secretKeyring(secrets(o.keys ?? { SF_PASSPORT_KEY: KEY_A }), { current: "SF_PASSPORT_KEY", ...(o.previous ? { previous: o.previous } : {}) }),
        providers: [new LocalAuthProvider()],
        grants: o.grants ?? [new OwnerGrant(OWNER)],
        ticks,
        newId: () => `pp_${name}_${++ids}`,
      });
      const at = (ms: number) => ticks.tick(REVOCATIONS_TICK, T0 + ms);
      await at(0);
      const owner = () => svc.authenticate({ provider: "local", subject: "owner@example.com" }, "cli", { ttl_ms: 3_600_000 });
      const audit = async () => db.all("SELECT passport_id, principal, action, resource, decision, reason, at FROM authz_audit ORDER BY seq");
      return { db, svc, at, owner, audit };
    }

    const P: ResourceRef = { project: "proj" };

    it("issues a person passport that authorizes by id and by token, from the principal's roles", async () => {
      const { svc, owner } = await setup();
      const { passport, token } = await owner();
      expect(passport).toMatchObject({ principal: OWNER, provider: "local", origin: "cli", kind: "person", parent_id: null });
      expect(passport.expires_at).toBe("2026-11-08T13:00:00.000Z");
      expect(token).not.toContain("owner@example.com");
      expect(await svc.authorize(passport.id, "approve_merge", P)).toMatchObject({ allow: true, reason: "allowed", principal: OWNER });
      expect(await svc.check(token, "approve_spec", P)).toMatchObject({ allow: true });

      const other = await svc.authenticate({ provider: "local", subject: "someone" }, "ui");
      expect(other.passport.principal).toBe("local:someone");
      expect(await svc.authorize(other.passport.id, "approve_spec", P)).toEqual({ allow: false, reason: "no_role", principal: "local:someone" });
      expect(await svc.authorize(other.passport.id, "submit_work", P)).toMatchObject({ allow: true });
    });

    it("refuses an identity its providers do not resolve, and a deny from any grant source wins", async () => {
      const deny: GrantSource = { remote: false, denies: async (s) => s.user_id === OWNER, roles: async () => [] };
      const { svc, owner } = await setup({ grants: [new OwnerGrant(OWNER), deny] });
      await expect(svc.authenticate({ provider: "github", subject: "1" }, "github")).rejects.toThrow(/no github identity/);
      const { passport } = await owner();
      expect(await svc.authorize(passport.id, "approve_spec", P)).toMatchObject({ allow: false, reason: "denied" });
    });

    it("detects a tampered token and a tampered store row", async () => {
      const { db, svc, owner } = await setup();
      const { passport, token } = await owner();
      const [prefix, body, sig] = token.split(".");
      const links = JSON.parse(Buffer.from(body!, "base64url").toString()) as Link[];
      const forged = [{ ...links[0]!, principal: "local:mallory" }];
      const forgedToken = `${prefix}.${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${sig}`;
      expect(await svc.check(forgedToken, "approve_spec", P)).toMatchObject({ allow: false, reason: "bad_signature" });
      const flipped = `${prefix}.${body}.${sig!.slice(0, -1)}${sig!.endsWith("0") ? "1" : "0"}`;
      expect(await svc.check(flipped, "approve_spec", P)).toMatchObject({ allow: false, reason: "bad_signature" });
      expect(await svc.check("not a token", "approve_spec", P)).toMatchObject({ allow: false, reason: "malformed" });

      const run = await svc.narrow(passport.id, { kind: "run", tools: ["git.push"] });
      await db.run("UPDATE identity_passports SET restrictions = ? WHERE id = ?", [JSON.stringify({ tools: ["git.push", "forge.merge"] }), run.passport.id]);
      expect(await svc.authorize(run.passport.id, "use_tool", { ...P, tool: "forge.merge" })).toMatchObject({ allow: false, reason: "tampered" });
      await db.run("UPDATE identity_passports SET expires_at = ? WHERE id = ?", ["2099-01-01T00:00:00.000Z", passport.id]);
      expect(await svc.authorize(passport.id, "approve_spec", P)).toMatchObject({ allow: false, reason: "tampered" });
    });

    it("narrows a run passport and a per-call token; neither can be widened", async () => {
      const { svc, owner } = await setup();
      const { passport } = await owner();
      const run = await svc.narrow(passport.id, {
        kind: "run",
        projects: ["proj"],
        items: ["wi_1"],
        runs: ["run_1"],
        branches: ["factory/wi_1"],
        paths: ["src/**"],
        tools: ["git.push", "forge.comment"],
        audience: ["tool-broker"],
        expires_at: "2026-11-08T12:30:00.000Z",
      });
      expect(run.passport).toMatchObject({ kind: "run", origin: "run", parent_id: passport.id, principal: OWNER, expires_at: "2026-11-08T12:30:00.000Z" });
      const ok: ResourceRef = { project: "proj", item: "wi_1", run: "run_1", branch: "factory/wi_1", paths: ["src/a.ts"], tool: "git.push", audience: "tool-broker" };
      expect(await svc.check(run.token, "use_tool", ok)).toMatchObject({ allow: true });
      expect(await svc.authorize(run.passport.id, "use_tool", ok)).toMatchObject({ allow: true });
      expect(await svc.check(run.token, "use_tool", { ...ok, paths: ["docs/x.md"] })).toMatchObject({ reason: "outside_paths" });
      expect(await svc.check(run.token, "use_tool", { ...ok, paths: ["src/../.env"] })).toMatchObject({ reason: "outside_paths" });
      const { paths: _, ...noPaths } = ok;
      expect(await svc.check(run.token, "use_tool", noPaths)).toMatchObject({ reason: "outside_paths" });
      expect(await svc.check(run.token, "use_tool", { ...ok, branch: "main" })).toMatchObject({ reason: "outside_branches" });
      expect(await svc.check(run.token, "use_tool", { ...ok, project: "other" })).toMatchObject({ reason: "outside_projects" });
      expect(await svc.check(run.token, "use_tool", { ...ok, tool: "forge.merge" })).toMatchObject({ reason: "outside_tools" });
      expect(await svc.check(run.token, "use_tool", { ...ok, audience: "sandbox-proxy" })).toMatchObject({ reason: "outside_audience" });

      await expect(svc.narrow(run.passport.id, { kind: "call", tools: ["forge.merge"] })).rejects.toThrow(/tools widened/);
      await expect(svc.narrow(run.passport.id, { kind: "call", paths: ["**"] })).rejects.toThrow(/paths widened/);
      await expect(svc.narrow(run.passport.id, { kind: "call", expires_at: "2026-11-08T12:31:00.000Z" })).rejects.toThrow(/expiry widened/);

      const callA = await svc.narrow(run.passport.id, { kind: "call", tools: ["git.push"], paths: ["src/lib/**"] });
      expect(callA.passport.expires_at).toBe("2026-11-08T12:30:00.000Z");
      expect(await svc.check(callA.token, "use_tool", { ...ok, paths: ["src/lib/x.ts"] })).toMatchObject({ allow: true });
      // A token for tool A is not accepted for tool B, though the run passport allows B.
      expect(await svc.check(callA.token, "use_tool", { ...ok, paths: ["src/lib/x.ts"], tool: "forge.comment" })).toMatchObject({ reason: "outside_tools" });
      expect(await svc.check(callA.token, "use_tool", { ...ok, paths: ["src/a.ts"] })).toMatchObject({ reason: "outside_paths" });
    });

    it("refuses a hand-made link that widens, even when it is signed correctly", async () => {
      const { svc, owner } = await setup();
      const { passport, token } = await owner();
      const run = await svc.narrow(passport.id, { kind: "run", tools: ["git.push"] });
      const [prefix, body, sig] = run.token.split(".");
      const links = JSON.parse(Buffer.from(body!, "base64url").toString()) as Link[];
      const wide = makeLink({ ...links[1]!, id: "pp_forged", parent_id: links[1]!.id, restrictions: { tools: ["git.push", "forge.merge"] } });
      const canonical = JSON.stringify([wide.id, wide.parent_id, wide.principal, wide.provider, wide.origin, wide.kind, wide.key_id, wide.issued_at, wide.expires_at, wide.restrictions]);
      const nextSig = createHmac("sha256", Buffer.from(sig!, "hex")).update(canonical).digest("hex");
      const forged = `${prefix}.${Buffer.from(JSON.stringify([...links, wide])).toString("base64url")}.${nextSig}`;
      expect(await svc.check(forged, "use_tool", { ...P, tool: "forge.merge" })).toMatchObject({ allow: false, reason: "malformed" });
      expect(token).not.toBe(run.token);
    });

    it("refuses an appended link whose expiry is not a time, or that turns a run into a person or moves its origin", async () => {
      // Anyone holding a token can append a link without the key; with `expires_at: null` every string comparison
      // is false, so the token would neither count as widened nor ever expire.
      const { svc, owner, at } = await setup();
      const { passport } = await owner();
      const run = await svc.narrow(passport.id, { kind: "run", tools: ["git.push"] });
      const [prefix, body, sig] = run.token.split(".");
      const links = JSON.parse(Buffer.from(body!, "base64url").toString()) as Link[];
      const append = (patch: Record<string, unknown>) => {
        const l = { ...links[1]!, id: "pp_forged", parent_id: links[1]!.id, ...patch } as Link;
        const canonical = JSON.stringify([l.id, l.parent_id, l.principal, l.provider, l.origin, l.kind, l.key_id, l.issued_at, l.expires_at, l.restrictions]);
        const next = createHmac("sha256", Buffer.from(sig!, "hex")).update(canonical).digest("hex");
        return `${prefix}.${Buffer.from(JSON.stringify([...links, l])).toString("base64url")}.${next}`;
      };
      const tool = { ...P, tool: "git.push" };
      expect(await svc.check(append({}), "use_tool", tool)).toMatchObject({ allow: true });
      await at(2 * 3_600_000); // the run passport expired with its parent
      for (const patch of [{ expires_at: null }, { expires_at: 4102444800000 }, { expires_at: "2099-01-01" }]) {
        expect(await svc.check(append(patch), "use_tool", tool)).toMatchObject({ allow: false, reason: "malformed" });
      }
      await at(0);
      expect(await svc.check(append({ kind: "person" }), "use_tool", tool)).toMatchObject({ allow: false, reason: "malformed" });
      expect(await svc.check(append({ origin: "github" }), "use_tool", tool)).toMatchObject({ allow: false, reason: "malformed" });
    });

    it("narrowing never widens (property)", async () => {
      const { svc, owner } = await setup();
      const { passport } = await owner();
      const tools = ["t1", "t2", "t3", "t4"];
      const paths = ["**", "src/**", "src/a/**", "src/a/x.ts", "docs/**", "docs/y.md"];
      let seed = 7;
      const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
      const pick = <T>(xs: readonly T[]) => xs.filter(() => rand(2) === 0);
      for (let i = 0; i < 40; i++) {
        const parentTools = pick(tools);
        const parentPaths = pick(paths);
        const parent = await svc.narrow(passport.id, { kind: "run", tools: parentTools, paths: parentPaths });
        const childTools = pick(tools);
        const childPaths = pick(paths);
        let child;
        try {
          child = await svc.narrow(parent.passport.id, { kind: "call", tools: childTools, paths: childPaths });
        } catch {
          continue;
        }
        for (const tool of tools) {
          for (const path of paths.filter((p) => !p.endsWith("**"))) {
            const r: ResourceRef = { project: null, tool, paths: [path] };
            const p = await svc.check(parent.token, "use_tool", r);
            const c = await svc.check(child.token, "use_tool", r);
            if (c.allow) expect(p.allow, `child allows ${tool} ${path} that its parent refuses`).toBe(true);
          }
        }
      }
    });

    it("a revoked passport and everything narrowed from it are refused; replicas learn it on their tick", async () => {
      const { db, svc, owner, at } = await setup();
      const { passport, token } = await owner();
      const run = await svc.narrow(passport.id, { kind: "run", tools: ["git.push"] });
      const replica = await setup({ db });
      expect(await replica.svc.check(run.token, "use_tool", { ...P, tool: "git.push" })).toMatchObject({ allow: true });

      // Two at once (two replicas, or a double click): both succeed, one row.
      await Promise.all([svc.revoke(passport.id, OWNER, "laptop lost"), svc.revoke(passport.id, OWNER, "laptop lost")]);
      await svc.revoke(passport.id, OWNER, "again");
      expect(await db.all("SELECT passport_id, revoked_by, reason FROM identity_revocations")).toEqual([{ passport_id: passport.id, revoked_by: OWNER, reason: "laptop lost" }]);
      expect(await svc.authorize(passport.id, "approve_spec", P)).toMatchObject({ allow: false, reason: "revoked" });
      expect(await svc.authorize(run.passport.id, "use_tool", { ...P, tool: "git.push" })).toMatchObject({ allow: false, reason: "revoked" });
      expect(await svc.check(token, "approve_spec", P)).toMatchObject({ allow: false, reason: "revoked" });
      expect(await svc.check(run.token, "use_tool", { ...P, tool: "git.push" })).toMatchObject({ allow: false, reason: "revoked" });
      await expect(svc.narrow(passport.id, { kind: "run" })).rejects.toThrow(/revoked/);

      // The replica checks offline from its last refresh until its next tick.
      expect(await replica.svc.check(run.token, "use_tool", { ...P, tool: "git.push" })).toMatchObject({ allow: true });
      await replica.at(10_000);
      expect(await replica.svc.check(run.token, "use_tool", { ...P, tool: "git.push" })).toMatchObject({ allow: false, reason: "revoked" });

      // Pruned once the passport has expired anyway.
      await at(3_600_000);
      expect(await db.all("SELECT passport_id FROM identity_revocations")).toEqual([]);
    });

    it("expires on Identity's tick, never on a wall clock", async () => {
      const { svc, at } = await setup();
      const { passport, token } = await svc.authenticate({ provider: "local", subject: "owner@example.com" }, "cli", { ttl_ms: 60_000 });
      await at(59_999);
      expect(await svc.check(token, "approve_spec", P)).toMatchObject({ allow: true });
      await at(60_000);
      expect(await svc.check(token, "approve_spec", P)).toMatchObject({ allow: false, reason: "expired" });
      expect(await svc.authorize(passport.id, "approve_spec", P)).toMatchObject({ allow: false, reason: "expired" });
      await expect(svc.narrow(passport.id, { kind: "run" })).rejects.toThrow(/expired/);
    });

    it("needs a tick before it decides anything", async () => {
      const db = await open();
      const svc = new PassportService({ db, keys: secretKeyring(secrets({ K: KEY_A }), { current: "K" }), providers: [], grants: [], ticks: new ManualTickGenerator() });
      await expect(svc.authorize("pp_x", "approve_spec", P)).rejects.toThrow(/no tick yet/);
      expect(await db.all("SELECT seq FROM authz_audit")).toEqual([]);
    });

    it("accepts a rotated-out key while it is listed as previous, and refuses it after", async () => {
      const db = await open();
      const old = await setup({ db, keys: { SF_PASSPORT_KEY: KEY_A } });
      const { passport, token } = await old.owner();
      const rotated = await setup({ db, keys: { SF_PASSPORT_KEY: KEY_B, SF_PASSPORT_KEY_PREVIOUS: KEY_A }, previous: ["SF_PASSPORT_KEY_PREVIOUS"] });
      expect(await rotated.svc.check(token, "approve_spec", P)).toMatchObject({ allow: true });
      const fresh = await rotated.owner();
      expect(fresh.passport.key_id).not.toBe(passport.key_id);
      const retired = await setup({ db, keys: { SF_PASSPORT_KEY: KEY_B } });
      expect(await retired.svc.check(token, "approve_spec", P)).toMatchObject({ allow: false, reason: "unknown_key" });
      expect(await retired.svc.authorize(passport.id, "approve_spec", P)).toMatchObject({ allow: false, reason: "unknown_key" });
    });

    it("writes every decision to authz_audit, with ids and never a token", async () => {
      const { svc, owner, audit } = await setup();
      const { passport, token } = await owner();
      const decisions: [Action, ResourceRef][] = [
        ["approve_spec", P],
        ["use_tool", { project: "proj", tool: "git.push", paths: ["src/a.ts"] }],
      ];
      for (const [action, r] of decisions) await svc.authorize(passport.id, action, r);
      await svc.check(token, "approve_merge", P);
      await svc.authorize("pp_missing", "approve_spec", P);
      const rows = await audit();
      expect(rows).toEqual([
        { passport_id: passport.id, principal: OWNER, action: "approve_spec", resource: '{"project":"proj"}', decision: "allow", reason: "allowed", at: "2026-11-08T12:00:00.000Z" },
        { passport_id: passport.id, principal: OWNER, action: "use_tool", resource: '{"project":"proj","paths":["src/a.ts"],"tool":"git.push"}', decision: "allow", reason: "allowed", at: "2026-11-08T12:00:00.000Z" },
        { passport_id: passport.id, principal: OWNER, action: "approve_merge", resource: '{"project":"proj"}', decision: "allow", reason: "allowed", at: "2026-11-08T12:00:00.000Z" },
        { passport_id: "pp_missing", principal: "unknown", action: "approve_spec", resource: '{"project":"proj"}', decision: "deny", reason: "unknown_passport", at: "2026-11-08T12:00:00.000Z" },
      ]);
      expect(JSON.stringify(rows)).not.toContain(token.split(".")[2]);
    });
  });
}

describe("local identity (solo default)", () => {
  it("is git user.email, else the OS user, else anonymous; never a display name", async () => {
    expect(localIdentity({ gitEmail: " Me@Example.com ", osUser: "me" })).toEqual({ provider: "local", subject: "me@example.com" });
    expect(localIdentity({ gitEmail: "Kim Seon Woo", osUser: "me" })).toEqual({ provider: "local", subject: "me" });
    expect(localIdentity({ gitEmail: null, osUser: null })).toEqual({ provider: "local", subject: "anonymous" });
    const p = new LocalAuthProvider();
    expect(await p.resolve({ provider: "local", subject: "me" })).toEqual({ user_id: "local:me" });
    expect(await p.resolve({ provider: "local", subject: "github:1" })).toEqual({ user_id: "github:1" });
    expect(await p.resolve({ provider: "slack", subject: "U1" })).toBeNull();
  });

  it("the owner holds every role; anonymous never does", async () => {
    expect(await new OwnerGrant("local:me").roles({ user_id: "local:me", accounts: [] })).toEqual(["owner"]);
    expect(await new OwnerGrant("local:me").roles({ user_id: "local:you", accounts: [] })).toEqual([]);
    expect(await new OwnerGrant("local:anonymous").roles({ user_id: "local:anonymous", accounts: [] })).toEqual([]);
  });

  it("a passport key shorter than 32 characters is refused", async () => {
    await expect(secretKeyring(secrets({ K: "short" }), { current: "K" }).current()).rejects.toThrow(/shorter than 32/);
  });
});
