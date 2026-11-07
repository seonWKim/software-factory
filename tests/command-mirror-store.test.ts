import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { INLINE_STEPS, STEPS_DIR, readSteps } from "../src/impl/store/mysql/migrations.js";
import { SqlFactoryStore } from "../src/impl/store/sql/sql-factory-store.js";
import { MIGRATIONS } from "../src/impl/store/sqlite/schema.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
import { BACKENDS } from "./helpers/store.js";

// The mirror mark of CLI commands on sync-source items (design 05-sources, CLI intake): a command appended with
// `mirror` is listed until it is marked mirrored, once. Never pin a step as the newest: compare with `>=`.
const STEP = 36;
const STEP_FILE = "0036-command-mirror.sql";

for (const b of BACKENDS) {
  describe(`${b.name}: the CLI command mirror mark`, () => {
    it("lists only commands appended with mirror, in seq order, until each is marked; a second mark changes nothing", async () => {
      const { store } = await b.make();
      await store.appendCliCommand({ key: "cli:local", actor: "local:me", command: "approve", args: { item: "wi_1" } });
      const a = (await store.appendCliCommand({ key: "cli:a", actor: "local:me", command: "approve", args: { item: "wi_2" }, mirror: true })).command;
      await store.appendCliCommand({ key: "cli:b", actor: "local:me", command: "retry", args: { item: "wi_2" }, mirror: true });
      expect(a).toMatchObject({ key: "cli:a", mirror: true });
      expect((await store.listUnmirroredCliCommands(10)).map((c) => c.key)).toEqual(["cli:a", "cli:b"]);
      expect((await store.listUnmirroredCliCommands(1)).map((c) => c.key)).toEqual(["cli:a"]);

      expect(await store.markCliCommandMirrored("cli:a")).toBe(true);
      expect(await store.markCliCommandMirrored("cli:a")).toBe(false);
      // Nothing to mirror, or no such command: no mark.
      expect(await store.markCliCommandMirrored("cli:local")).toBe(false);
      expect(await store.markCliCommandMirrored("cli:missing")).toBe(false);
      expect((await store.listUnmirroredCliCommands(10)).map((c) => c.key)).toEqual(["cli:b"]);
      // The command log itself is unchanged: every command is still read by cursor.
      expect((await store.listCliCommandsAfter(0, 10)).map((c) => c.key)).toEqual(["cli:local", "cli:a", "cli:b"]);
    });
  });
}

describe("SQLite migration 36: the mirror mark", () => {
  it("adds mirror (0 on older rows) and mirrored_at to an existing database's command inbox", async () => {
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(STEP);
    const raw = new DatabaseSync(":memory:");
    for (const m of MIGRATIONS.slice(0, STEP - 1)) raw.exec(m);
    raw.exec("INSERT INTO command_inbox (command_key, actor, command, args, created_at) VALUES ('old', 'local:me', 'approve', '{}', 't')");
    raw.exec(MIGRATIONS[STEP - 1]!);
    expect(raw.prepare("SELECT command_key, mirror, mirrored_at FROM command_inbox").all().map((r) => ({ ...r }))).toEqual([
      { command_key: "old", mirror: 0, mirrored_at: null },
    ]);
    raw.close();
    const store = new SqlFactoryStore(new SqliteDriver(":memory:"), new FakeClock());
    await store.migrate();
    expect(await store.listUnmirroredCliCommands(10)).toEqual([]);
    await store.close();
  });
});

describe("MySQL step 36 (command-mirror)", () => {
  it("is one ALTER right after step 35 with the same columns as SQLite migration 36", () => {
    expect(readSteps(STEPS_DIR, INLINE_STEPS).find((s) => s.name === "command-mirror")).toMatchObject({
      number: STEP, from: STEP - 1, kind: "sql", file: STEP_FILE,
    });
    const sql = readFileSync(join(STEPS_DIR, STEP_FILE), "utf8");
    const statements = sql.split("\n").filter((l) => l.trim() !== "" && !l.startsWith("--"));
    expect(statements).toHaveLength(1);
    for (const c of ["ADD COLUMN mirror ", "ADD COLUMN mirrored_at ", "ADD INDEX command_inbox_mirror (mirror, mirrored_at, seq)"]) {
      expect(sql).toContain(c);
    }
    for (const c of ["ADD COLUMN mirror ", "ADD COLUMN mirrored_at ", "command_inbox_mirror ON command_inbox (mirror, mirrored_at, seq)"]) {
      expect(MIGRATIONS[STEP - 1]).toContain(c);
    }
  });
});
