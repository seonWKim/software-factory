// `factory schedule add`, `edit` and `list` with feedback schedule grants (design 08-schedules): each --grant is stored
// in the action settings, the notes folder is made on add, list shows each grant in plain words, and a grant off the
// rules is refused, storing nothing.

import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ADD, setup, stored } from "./helpers/schedule-cli.js";

describe("feedback schedule grants", () => {
  const FEEDBACK = [...ADD.slice(0, -1), "feedback", "--body", "Review the pages"];

  it("add stores each --grant, makes the notes folder, and list shows each grant in plain words", async () => {
    const repo = await mkdtemp(join(tmpdir(), "grants-"));
    const { store, cli } = await setup({ makeNotesFolder: async (folder) => void (await mkdir(join(repo, folder), { recursive: true })) });
    const add = await cli([...FEEDBACK, "--grant", "browser=http://localhost:5173/", "--grant", "notes", "--grant", "repo=/src/other#dev", "--grant", "shell=/data/app.db"]);
    expect(add.code).toBe(0);
    expect((await stat(join(repo, ".factory", "notes", "sch_fb"))).isDirectory()).toBe(true);
    expect((await stored(store))!.action!.settings.grants).toEqual([
      { kind: "browser", url: "http://localhost:5173/" }, { kind: "notes" }, { kind: "repo", path: "/src/other", base_ref: "dev" },
      { kind: "shell", command: "sqlite3 -readonly", db: "/data/app.db" },
    ]);
    const line = (await cli(["list"])).lines.find((l) => l.startsWith("sch_fb\t"))!;
    expect(line).toContain("browser: Browse may read only http://localhost:5173/");
    expect(line).toContain("notes: may write only in .factory/notes/sch_fb/");
    expect(line).toContain("repo: its agent runs in /src/other (dev) and no other");
    expect(line).toContain("shell: only sqlite3 -readonly /data/app.db");
    await rm(repo, { recursive: true, force: true });
  });

  it("edit replaces the grants, --grant none clears them, and the prompt stays", async () => {
    const { store, cli } = await setup();
    expect((await cli([...FEEDBACK, "--grant", "notes"])).code).toBe(0);
    expect((await cli(["edit", "sch_fb", "--grant", "browser=http://127.0.0.1:8080/"])).code).toBe(0);
    expect((await stored(store))!.action!.settings).toEqual({ prompt: "Review the pages", grants: [{ kind: "browser", url: "http://127.0.0.1:8080/" }] });
    expect((await cli(["edit", "sch_fb", "--grant", "none"])).code).toBe(0);
    expect((await stored(store))!.action!.settings).toEqual({ prompt: "Review the pages", grants: [] });
    expect((await cli(["list"])).lines.find((l) => l.startsWith("sch_fb\t"))).not.toContain("grants:");
  });

  it("refuses add --id ../.. with a notes grant and makes no folder; a plain ID still gets .factory/notes/<id>/", async () => {
    const repo = await mkdtemp(join(tmpdir(), "grants-"));
    const { store, cli } = await setup({ makeNotesFolder: async (folder) => void (await mkdir(join(repo, folder), { recursive: true })) });
    const bad = ["add", "--id", "../..", "--title", "Feedback", "--cadence", "daily", "--spec", "09:00", "--zone", "Asia/Seoul", "--action", "feedback", "--body", "x", "--grant", "notes"];
    const tryCli = async (args: string[]) => { try { return await cli(args); } catch (e) { return { code: 1, lines: [(e as Error).message] }; } };
    const refused = await tryCli(bad);
    expect(refused.code).not.toBe(0);
    expect(refused.lines.join("\n")).toContain("schedule ID");
    for (const id of ["a/b", "a.b", "a b"]) expect((await tryCli(bad.map((w) => (w === "../.." ? id : w)))).code).not.toBe(0);
    expect(await store.listSchedules()).toEqual([]);
    expect(await readdir(repo)).toEqual([]);
    expect((await cli(bad.map((w) => (w === "../.." ? "daily-review" : w)))).code).toBe(0);
    expect((await stat(join(repo, ".factory", "notes", "daily-review"))).isDirectory()).toBe(true);
    await rm(repo, { recursive: true, force: true });
  });

  it("refuses a grant on any other action, a URL off the sandbox and a repo in the state folder, storing nothing", async () => {
    const { store, cli } = await setup();
    expect((await cli([...ADD, "--grant", "notes"])).lines[0]).toContain("only a feedback schedule takes --grant");
    expect((await cli([...FEEDBACK, "--grant", "browser=https://example.com/"])).lines[0]).toContain("sandbox URL");
    expect((await cli([...FEEDBACK, "--grant", "repo=/home/me/app/.factory/x"])).lines[0]).toContain("state folder");
    expect(await stored(store)).toBeUndefined();
  });
});
