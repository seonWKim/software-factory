import { describe, expect, it } from "vitest";
import { Controller } from "../src/core/controller.js";
import type { UserId } from "../src/core/types.js";
import { GitHubAuthProvider } from "../src/impl/auth/github-auth-provider.js";
import { LINK_CODE_PATTERN, linkCodeCommand, newLinkCode } from "../src/impl/auth/link-code.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import type { SqlFactoryStore } from "../src/impl/store/sql/sql-factory-store.js";
import { LINK_CODE_MAX_FAILURES, LINK_CODE_TTL_MS } from "../src/interfaces/factory-store.js";
import { newStore } from "./helpers/store.js";
import { FakeSource, cleanScanner, config, issueRef, recordingLog } from "./helpers/fakes.js";

// Identity links and one-time link codes (design 2026-11-01, issue #107). SQLite only: the MySQL step file for
// these tables is not part of this change (see the PR description).

const USER = "github:1" as UserId;
const slack = (subject: string) => ({ provider: "slack" as const, subject });
const gh = (subject: string, login?: string) => ({ provider: "github" as const, subject, ...(login ? { login } : {}) });

/** Every row of every table, as one string: a plain code must not appear anywhere in it. */
async function dump(store: SqlFactoryStore): Promise<string> {
  const db = (store as unknown as { db: { all(sql: string): Promise<Record<string, unknown>[]> } }).db;
  const tables = await db.all("SELECT name FROM sqlite_master WHERE type = 'table'");
  const out: unknown[] = [];
  for (const t of tables) out.push(await db.all(`SELECT * FROM ${String(t.name)}`));
  return JSON.stringify(out);
}

describe("identity links: store", () => {
  it("a code links the account that redeems it, found by provider and subject only", async () => {
    const { store } = await newStore();
    const code = newLinkCode();
    await store.createLinkCode(USER, code);
    expect(await store.resolveLink("slack", "U1")).toBeNull();
    expect(await store.redeemLinkCode(code, slack("U1"))).toEqual({ ok: true, user_id: USER });
    expect(await store.resolveLink("slack", "U1")).toBe(USER);
    expect(await store.resolveLink("github", "U1")).toBeNull();
    expect(await store.listLinks(USER)).toEqual([{ provider: "slack", subject: "U1" }]);
  });

  it("a wrong code is refused, counts as a failed attempt, and links nothing", async () => {
    const { store } = await newStore();
    const code = newLinkCode();
    await store.createLinkCode(USER, code);
    expect(await store.redeemLinkCode("WRONGCODE1", slack("U1"))).toEqual({ ok: false, reason: "invalid" });
    expect(await store.resolveLink("slack", "U1")).toBeNull();
    expect(await store.listLinks(USER)).toEqual([]);
    expect(await dump(store)).toMatch(/"failures":1/);
  });

  it("works once: a second account gets `used`, and the same account again is a no-op", async () => {
    const { store } = await newStore();
    const code = newLinkCode();
    await store.createLinkCode(USER, code);
    expect(await store.redeemLinkCode(code, slack("U1"))).toEqual({ ok: true, user_id: USER });
    expect(await store.redeemLinkCode(code, slack("U1"))).toEqual({ ok: true, user_id: USER });
    expect(await store.redeemLinkCode(code, slack("U2"))).toEqual({ ok: false, reason: "used" });
    expect(await store.resolveLink("slack", "U2")).toBeNull();
  });

  it("expires after 10 minutes", async () => {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const code = newLinkCode();
    expect(LINK_CODE_TTL_MS).toBe(10 * 60 * 1000);
    const { expires_at } = await store.createLinkCode(USER, code);
    expect(expires_at).toBe(new Date(clock.now().getTime() + LINK_CODE_TTL_MS).toISOString());
    clock.advance(LINK_CODE_TTL_MS);
    expect(await store.redeemLinkCode(code, slack("U1"))).toEqual({ ok: false, reason: "expired" });
    expect(await store.resolveLink("slack", "U1")).toBeNull();
  });

  it("locks after 5 wrong attempts: the right code is refused after that", async () => {
    const { store } = await newStore();
    const code = newLinkCode();
    await store.createLinkCode(USER, code);
    expect(LINK_CODE_MAX_FAILURES).toBe(5);
    for (let i = 0; i < 4; i++) expect((await store.redeemLinkCode(`BAD${i}XXXXXX`, slack("U9"))).ok).toBe(false);
    // Four wrong tries: still open.
    const other = newLinkCode();
    await store.createLinkCode(USER, other);
    expect(await store.redeemLinkCode(other, slack("U2"))).toEqual({ ok: true, user_id: USER });
    expect((await store.redeemLinkCode("BAD4XXXXXX", slack("U9"))).ok).toBe(false);
    expect(await store.redeemLinkCode(code, slack("U1"))).toEqual({ ok: false, reason: "locked" });
    expect(await store.resolveLink("slack", "U1")).toBeNull();
  });

  it("an account linked to another user is refused and the code stays usable", async () => {
    const { store } = await newStore();
    const a = newLinkCode();
    await store.createLinkCode("github:2" as UserId, a);
    await store.redeemLinkCode(a, slack("U1"));
    const b = newLinkCode();
    await store.createLinkCode(USER, b);
    expect(await store.redeemLinkCode(b, slack("U1"))).toEqual({ ok: false, reason: "already_linked" });
    expect(await store.resolveLink("slack", "U1")).toBe("github:2");
    expect(await store.redeemLinkCode(b, slack("U3"))).toEqual({ ok: true, user_id: USER });
  });

  it("stores only a hash of the code", async () => {
    const { store } = await newStore();
    const code = newLinkCode();
    await store.createLinkCode(USER, code);
    await store.redeemLinkCode(code, slack("U1"));
    expect(await dump(store)).not.toContain(code);
  });
});

describe("identity links: codes and the CLI", () => {
  it("newLinkCode gives a fresh code of the documented shape every time", () => {
    const codes = new Set(Array.from({ length: 50 }, () => newLinkCode()));
    expect(codes.size).toBe(50);
    for (const c of codes) expect(c).toMatch(LINK_CODE_PATTERN);
  });

  it("`factory link-code <user_id>` stores a code and prints it with the /link line and the expiry", async () => {
    const { store } = await newStore();
    const text = await linkCodeCommand(store, ["github:1"]);
    const code = /\/link (\S+)/.exec(text)![1]!;
    expect(code).toMatch(LINK_CODE_PATTERN);
    expect(text).toContain("10 minutes");
    expect(await store.redeemLinkCode(code, slack("U1"))).toEqual({ ok: true, user_id: USER });
  });

  it("refuses a missing or malformed user id", async () => {
    const { store } = await newStore();
    await expect(linkCodeCommand(store, [])).rejects.toThrow(/usage: factory link-code <user_id>/);
    await expect(linkCodeCommand(store, ["alice"])).rejects.toThrow(/user_id/);
  });
});

describe("identity links: resolve", () => {
  it("a GitHub account resolves to github:<id>; a linked account to its user; an unlinked Slack account to nobody", async () => {
    const { store } = await newStore();
    const auth = new GitHubAuthProvider(store, []);
    expect(await auth.resolve(gh("7", "seven"))).toMatchObject({ user_id: "github:7" });
    expect(await auth.resolve(slack("U1"))).toBeNull();
    const code = newLinkCode();
    await store.createLinkCode(USER, code);
    await store.redeemLinkCode(code, slack("U1"));
    expect(await auth.resolve(slack("U1"))).toMatchObject({ user_id: USER });
  });

  it("a display name change does not change which user an identity maps to", async () => {
    const { store } = await newStore();
    const auth = new GitHubAuthProvider(store, []);
    const code = newLinkCode();
    await store.createLinkCode(USER, code);
    await store.redeemLinkCode(code, gh("42", "old-name"));
    expect(await auth.resolve(gh("42", "old-name"))).toMatchObject({ user_id: USER });
    expect(await auth.resolve(gh("42", "new-name"))).toMatchObject({ user_id: USER });
    expect(await auth.resolve(gh("43", "old-name"))).toMatchObject({ user_id: "github:43" });
  });
});

describe("/link through the controller", () => {
  async function setup() {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const source = new FakeSource();
    const log = recordingLog();
    const auth = new GitHubAuthProvider(store, []);
    const controller = new Controller({ store, source, auth, clock, config, log, scanner: cleanScanner });
    let n = 100;
    const link = async (body: string, who = gh("5", "five")) => {
      const comment_id = String(++n);
      source.queue.push({ kind: "plain_comment", source: issueRef(9), comment_id, author: who, body });
      await controller.tickIntake();
      return source.comments.filter((c) => c.marker === `<!-- factory:link:${comment_id} -->`);
    };
    return { store, source, log, link };
  }

  it("links the commenter's account on any issue, with one reply and no code in replies or logs", async () => {
    const f = await setup();
    const plain = newLinkCode();
    await f.store.createLinkCode(USER, plain);
    const replies = await f.link(`/link ${plain}`);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.body).toContain("`github:1`");
    expect(await f.store.resolveLink("github", "5")).toBe(USER);
    expect(JSON.stringify(f.source.comments)).not.toContain(plain);
    expect(JSON.stringify(f.log.lines)).not.toContain(plain);
  });

  it("a wrong code gets one refusal, links nothing, and is not echoed", async () => {
    const f = await setup();
    await f.store.createLinkCode(USER, newLinkCode());
    const replies = await f.link("/link NOTTHECODE");
    expect(replies).toHaveLength(1);
    expect(replies[0]!.body).toMatch(/not linked/);
    expect(replies[0]!.body).not.toContain("NOTTHECODE");
    expect(await f.store.resolveLink("github", "5")).toBeNull();
    expect(JSON.stringify(f.log.lines)).not.toContain("NOTTHECODE");
  });

  it("is case-insensitive in the command word and ignores other plain comments", async () => {
    const f = await setup();
    const plain = newLinkCode();
    await f.store.createLinkCode(USER, plain);
    expect(await f.link("please link me")).toEqual([]);
    expect(await f.link(`/LINK ${plain}`)).toHaveLength(1);
    expect(await f.store.resolveLink("github", "5")).toBe(USER);
  });
});
