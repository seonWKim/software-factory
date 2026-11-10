import { describe, expect, it } from "vitest";
import {
  type AuthProvider,
  type ExternalIdentity,
  OwnerGrant,
  PassportService,
  ProfileStore,
  REVOCATIONS_TICK,
  checkDisplayName,
  secretKeyring,
} from "../src/identity/index.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
import { ManualTickGenerator } from "../src/shared/ticks/plugins/manual/manual-tick-generator.js";
import type { SqlExecutor } from "../src/state/index.js";
import { MYSQL_URL, newMigratedMysqlDriver } from "./helpers/store.js";

// Display names live once, in identity_profiles, keyed by the user id (owner decision 2026-11-08). SQLite always;
// MySQL when SF_TEST_MYSQL_URL is set.

const AT = "2026-11-08T12:00:00.000Z";
const LATER = "2026-11-08T13:00:00.000Z";

async function sqlite(): Promise<SqlExecutor> {
  const d = new SqliteDriver(":memory:");
  await d.migrate();
  return d;
}


const BACKENDS: [string, boolean, () => Promise<SqlExecutor>][] = [
  ["sqlite", true, sqlite],
  ["mysql", Boolean(MYSQL_URL), newMigratedMysqlDriver],
];

for (const [name, enabled, open] of BACKENDS) {
  describe.skipIf(!enabled)(`identity profiles (${name})`, () => {
    it("stores one name per user id, replaced by the person, read back by id", async () => {
      const profiles = new ProfileStore(await open());
      expect(await profiles.get("local:me@example.com")).toBeNull();
      expect(await profiles.set("local:me@example.com", "  Kim Seon Woo ", "self", AT)).toBe(true);
      expect(await profiles.set("local:me@example.com", "Kim Seon Woo", "self", AT)).toBe(true); // safe to run twice
      expect(await profiles.get("local:me@example.com")).toEqual({ user_id: "local:me@example.com", display_name: "Kim Seon Woo", source: "self", updated_at: AT });
      await profiles.set("local:me@example.com", "Seon Woo", "self", LATER);
      await profiles.set("github:1", "Octo Cat", "github", AT);
      expect(await profiles.displayNames(["local:me@example.com", "github:1", "local:nobody"])).toEqual(
        new Map([["local:me@example.com", "Seon Woo"], ["github:1", "Octo Cat"]]),
      );
      expect(await profiles.displayNames([])).toEqual(new Map());
    });

    it("a provider's name never replaces one the person chose; it replaces an earlier provider name", async () => {
      const profiles = new ProfileStore(await open());
      await profiles.set("oidc:a", "Chosen", "self", AT);
      expect(await profiles.set("oidc:a", "From IdP", "oidc", LATER)).toBe(false);
      expect((await profiles.get("oidc:a"))?.display_name).toBe("Chosen");
      await profiles.set("oidc:b", "Old", "oidc", AT);
      expect(await profiles.set("oidc:b", "New", "oidc", LATER)).toBe(true);
      expect(await profiles.get("oidc:b")).toMatchObject({ display_name: "New", source: "oidc", updated_at: LATER });
    });

    it("authenticate stores the name a provider supplies (the enterprise hook); the passport carries only the id", async () => {
      const db = await open();
      const named: AuthProvider = {
        provider: "oidc",
        resolve: async (i: ExternalIdentity) => ({ user_id: `oidc:${i.subject}` }),
        displayName: async () => "Ada Lovelace",
      };
      const ticks = new ManualTickGenerator();
      const svc = new PassportService({
        db,
        keys: secretKeyring({ get: async () => ({ reveal: () => "k".repeat(40) }) }, { current: "K" }),
        providers: [named],
        grants: [new OwnerGrant("oidc:ada")],
        ticks,
      });
      await ticks.tick(REVOCATIONS_TICK, Date.parse(AT));
      const { passport, token } = await svc.authenticate({ provider: "oidc", subject: "ada" }, "ui");
      expect(passport.principal).toBe("oidc:ada");
      expect(token).not.toContain("Ada");
      expect(await new ProfileStore(db).get("oidc:ada")).toEqual({ user_id: "oidc:ada", display_name: "Ada Lovelace", source: "oidc", updated_at: AT });
      const [row] = await db.all("SELECT principal FROM identity_passports WHERE id = ?", [passport.id]);
      expect(row).toEqual({ principal: "oidc:ada" });
    });
  });
}

describe("display name checks", () => {
  it("trims, and refuses empty, overlong and control characters", () => {
    expect(checkDisplayName("  Kim ")).toEqual({ ok: true, name: "Kim" });
    expect(checkDisplayName("   ")).toMatchObject({ ok: false });
    expect(checkDisplayName("x".repeat(101))).toMatchObject({ ok: false });
    expect(checkDisplayName("a\nb")).toMatchObject({ ok: false });
  });
});
