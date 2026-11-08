// Local users on the dashboard (design 08-permissions and 09-dashboard-app, issue #445). GET /api/v1/users lists the
// local users, the static grant users and their links, and the viewer's identity, with no forge call; POST
// /api/v1/users adds, changes or removes a local user through the CLI's own `users` actions, behind the pause
// route's guards (Host, Origin, Content-Type, CSRF token, body size, JSON, body) and then the owner check. Every
// refusal writes nothing: no identity_local_users row and no identity_local_user_changes row.

import { describe, expect, it } from "vitest";
import type { LogFields, Logger } from "../src/core/log.js";
import type { UserId } from "../src/core/types.js";
import type { CliIdentity } from "../src/core/local-cli.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { LocalAuthProvider } from "../src/impl/auth/local-auth-provider.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { HealthMonitor } from "../src/ui/health.js";
import { type UiRequest, respond } from "../src/ui/server.js";
import { newCsrfToken } from "../src/ui/settings-api.js";
import { type UiUsers, type UsersDeps, USERS_PATH } from "../src/ui/users-api.js";
import { PROJECT_KEY, newStore } from "./helpers/store.js";

const HOST = "127.0.0.1:4310";
const ORIGIN = `http://${HOST}`;
const OWNER = "local:owner@example.com" as UserId;
const ALICE = "local:alice" as UserId;
const STATIC = "github:9" as UserId;
const ANON = "local:anonymous" as UserId;

class MemLog implements Logger {
  lines: { msg: string; fields?: LogFields | undefined }[] = [];
  info(msg: string, fields?: LogFields) {
    this.lines.push({ msg, fields });
  }
  warn() {}
  error() {}
}

/** The writes the users route can make; a refusal must reach none of them. */
const WRITES = ["claimLocalOwner", "setLocalUserRole", "removeLocalUser"] as const;

async function setup(opts: { me?: CliIdentity; owner?: UserId | null; wired?: boolean } = {}) {
  const { store: real } = await newStore(new FakeClock());
  const owner = opts.owner === undefined ? OWNER : opts.owner;
  if (owner !== null) await real.claimLocalOwner(owner);
  const calls: string[] = [];
  // Records every call of a write method, so a refusal can be shown to reach none.
  const store = new Proxy(real, {
    get(target, key) {
      const v = Reflect.get(target, key);
      if (typeof v !== "function") return v;
      if ((WRITES as readonly (string | symbol)[]).includes(key)) return (...a: unknown[]) => (calls.push(String(key)), (v as (...x: unknown[]) => unknown).apply(target, a));
      return v.bind(target);
    },
  }) as FactoryStore;
  const log = new MemLog();
  const users: UiUsers = {
    identity: opts.me ?? { user: OWNER, from: "git user.email" },
    permissions: { grants: ["static"], static: { roles: { [STATIC]: { "*": ["approver"], [PROJECT_KEY]: ["requester"] } } } },
    csrfToken: newCsrfToken(),
    log,
  };
  const d: UsersDeps = {
    store,
    scanner: new PatternEgressScanner(async () => []),
    clock: new FakeClock(),
    lease_ms: 300_000,
    health: new HealthMonitor(async () => [], new FakeClock()),
    ...(opts.wired === false ? {} : { users }),
  };
  const changes = async () => (await real.listTableRows({ table: "identity_local_user_changes", limit: 200 }))!.rows;
  return { d, real, users, log, changes, calls, writes: () => calls.length };
}

function post(u: UiUsers | undefined, body: unknown, over: Partial<UiRequest> = {}): UiRequest {
  return {
    method: "POST", url: USERS_PATH, host: HOST, origin: ORIGIN, contentType: "application/json",
    csrfToken: u?.csrfToken ?? "x", body: typeof body === "string" ? body : JSON.stringify(body), ...over,
  };
}

const parse = (r: { body: string }) => JSON.parse(r.body);
const get = (d: UsersDeps) => respond(d, { method: "GET", url: USERS_PATH, host: HOST });

describe("GET /api/v1/users", () => {
  it("lists the local users, the static grant users and their links, and the viewer, from the store alone", async () => {
    const { d, real, users } = await setup();
    await real.setLocalUserRole(ALICE, "requester", OWNER);
    await real.createLinkCode(ALICE, "ABCDEFGHJK");
    await real.redeemLinkCode("ABCDEFGHJK", { provider: "github", subject: "12345" });
    const r = await get(d);
    expect(r.status).toBe(200);
    const v = parse(r);
    expect(v.csrf_token).toBe(users.csrfToken);
    expect(v.viewer).toEqual({ user_id: OWNER, source: "git user.email", role: "owner" });
    expect(v.can_change).toBe(true);
    expect(v.read_only_reason).toBeNull();
    const at = (await real.getLocalUser(ALICE))!.created_at;
    expect(v.users).toEqual([
      expect.objectContaining({ user_id: OWNER, role: "owner", source: "local", added_by: OWNER, links: [] }),
      { user_id: ALICE, role: "requester", source: "local", added_by: OWNER, added_at: at, projects: [], links: [{ provider: "github", subject: "12345" }] },
      { user_id: STATIC, role: "approver", source: "static", added_by: null, added_at: null, links: [],
        projects: [{ project: "*", roles: ["approver"] }, { project: PROJECT_KEY, roles: ["requester"] }] },
    ]);
  });

  it("shows a non-owner the list read-only, with the reason a write would get", async () => {
    const { d } = await setup({ me: { user: ALICE, from: "OS user" } });
    const v = parse(await get(d));
    expect(v.viewer).toEqual({ user_id: ALICE, source: "OS user", role: null });
    expect(v.can_change).toBe(false);
    expect(v.read_only_reason).toBe(`only the local owner (${OWNER}) can change roles; you are ${ALICE}`);
  });

  it("on a fresh store a named viewer may write (it becomes the owner); anonymous may not", async () => {
    expect(parse(await get((await setup({ owner: null, me: { user: ALICE, from: "git user.email" } })).d))).toMatchObject({ can_change: true, read_only_reason: null });
    const anon = parse(await get((await setup({ owner: null, me: { user: ANON, from: "anonymous" } })).d));
    expect(anon).toMatchObject({ viewer: { user_id: ANON, source: "anonymous" }, can_change: false });
    expect(anon.read_only_reason).toContain("only the local owner (none yet) can change roles");
  });

  it("is a 404 when the users route is not wired", async () => {
    expect((await get((await setup({ wired: false })).d)).status).toBe(404);
  });
});

describe("POST /api/v1/users", () => {
  it("the owner adds local:alice as approver; she then passes the local auth plugin's approve check", async () => {
    const { d, real, users, log, changes } = await setup();
    const auth = new LocalAuthProvider(real);
    const approve = () => auth.authorize({ user_id: ALICE, attributes: {} }, "approve_spec", { kind: "project", id: PROJECT_KEY });
    expect((await approve()).allow).toBe(false);
    const r = await respond(d, post(users, { action: "add", user_id: ALICE, role: "approver" }));
    expect(r.status).toBe(200);
    expect(parse(r).users.map((u: { user_id: string; role: string }) => [u.user_id, u.role])).toContainEqual([ALICE, "approver"]);
    expect(await approve()).toEqual({ allow: true });
    expect(await changes()).toMatchObject([{ user_id: ALICE, action: "add", old_role: null, new_role: "approver", actor: OWNER }]);
    expect(log.lines).toEqual([{ msg: "local user changed", fields: { action: "add", user_id: ALICE, role: "approver", actor: OWNER } }]);
  });

  it("changes and removes a user, one audit row each", async () => {
    const { d, real, users, changes } = await setup();
    await respond(d, post(users, { action: "add", user_id: ALICE, role: "requester" }));
    expect((await respond(d, post(users, { action: "change", user_id: ALICE, role: "approver" }))).status).toBe(200);
    expect((await real.getLocalUser(ALICE))!.role).toBe("approver");
    expect((await respond(d, post(users, { action: "remove", user_id: ALICE }))).status).toBe(200);
    expect(await real.getLocalUser(ALICE)).toBeNull();
    expect((await changes()).map((c) => c.action).sort()).toEqual(["add", "change", "remove"]);
  });

  it("refuses a non-owner's add, change and remove with 403 and writes nothing", async () => {
    const { d, real, users, changes, calls } = await setup({ me: { user: ALICE, from: "OS user" } });
    await real.setLocalUserRole("local:bob" as UserId, "requester", OWNER);
    const before = await changes();
    for (const body of [
      { action: "add", user_id: "local:carol", role: "approver" },
      { action: "change", user_id: "local:bob", role: "approver" },
      { action: "remove", user_id: "local:bob" },
    ]) {
      const r = await respond(d, post(users, body));
      expect(r.status, body.action).toBe(403);
      expect(parse(r).error).toBe(`only the local owner (${OWNER}) can change roles; you are ${ALICE}`);
    }
    // Only the owner claim is asked (it returns the existing owner and writes nothing); no role write is reached.
    expect(calls.filter((c) => c !== "claimLocalOwner")).toEqual([]);
    expect(await changes()).toEqual(before);
    expect((await real.getLocalUser("local:bob" as UserId))!.role).toBe("requester");
    expect(await real.getLocalUser("local:carol" as UserId)).toBeNull();
  });

  it("refuses to remove or demote the owner's row with 409 and writes nothing", async () => {
    const { d, real, users, changes } = await setup();
    for (const body of [{ action: "remove", user_id: OWNER }, { action: "change", user_id: OWNER, role: "requester" }]) {
      const r = await respond(d, post(users, body));
      expect(r.status, body.action).toBe(409);
    }
    expect((await real.getLocalUser(OWNER))!.role).toBe("owner");
    expect(await changes()).toEqual([]);
  });

  it("refuses a bad user ID, a bad body and anonymous as approver with 400, before the owner check", async () => {
    const { d, users, changes, writes } = await setup({ me: { user: ALICE, from: "OS user" } });
    for (const body of [
      { action: "add", user_id: "alice", role: "approver" },
      { action: "add", user_id: "local:a b", role: "approver" },
      { action: "add", user_id: "Local:alice", role: "approver" },
      { action: "add", user_id: ANON, role: "approver" },
      { action: "add", user_id: ALICE, role: "owner" },
      { action: "add", user_id: ALICE },
      { action: "remove", user_id: ALICE, role: "approver" },
      { action: "promote", user_id: ALICE, role: "approver" },
      { action: "add", user_id: ALICE, role: "approver", name: "Alice Smith" },
      [],
      "nope",
    ]) {
      const r = await respond(d, post(users, body));
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    expect(writes()).toBe(0);
    expect(await changes()).toEqual([]);
  });

  it("runs the guards in the pause route's order, each before any store write", async () => {
    const { d, users, changes, writes } = await setup();
    const body = { action: "add", user_id: ALICE, role: "approver" };
    const cases: [Partial<UiRequest>, number][] = [
      [{ host: "evil.example" }, 403],
      [{ origin: "http://evil.example" }, 403],
      [{ origin: undefined }, 403],
      [{ contentType: "text/plain" }, 415],
      [{ csrfToken: undefined }, 403],
      [{ csrfToken: newCsrfToken() }, 403],
      [{ bodyTooLarge: true }, 413],
      [{ body: "{" }, 400],
      // Each earlier guard wins over a later failure: a bad Origin with no token is the Origin's 403, and so on.
      [{ contentType: "text/plain", csrfToken: undefined }, 415],
      [{ csrfToken: undefined, bodyTooLarge: true }, 403],
      [{ bodyTooLarge: true, body: "{" }, 413],
    ];
    for (const [over, status] of cases) expect((await respond(d, post(users, body, over))).status, JSON.stringify(over)).toBe(status);
    expect(parse(await respond(d, post(users, body, { csrfToken: undefined }))).error).toContain("x-csrf-token");
    expect(writes()).toBe(0);
    expect(await changes()).toEqual([]);
  });

  it("on a fresh store the first write makes the viewer the owner, as the CLI does; anonymous never becomes owner", async () => {
    const fresh = await setup({ owner: null, me: { user: ALICE, from: "git user.email" } });
    expect((await respond(fresh.d, post(fresh.users, { action: "add", user_id: "local:bob", role: "requester" }))).status).toBe(200);
    expect((await fresh.real.getLocalUser(ALICE))!.role).toBe("owner");

    const anon = await setup({ owner: null, me: { user: ANON, from: "anonymous" } });
    const r = await respond(anon.d, post(anon.users, { action: "add", user_id: "local:bob", role: "requester" }));
    expect(r.status).toBe(403);
    expect(parse(r).error).toContain("only the local owner (none yet) can change roles");
    expect(await anon.real.listLocalUsers()).toEqual([]);
    expect(await anon.changes()).toEqual([]);
  });

  it("is a JSON 405 when the users route is not wired", async () => {
    const { d } = await setup({ wired: false });
    expect((await respond(d, post(undefined, { action: "remove", user_id: ALICE }))).status).toBe(405);
  });
});
