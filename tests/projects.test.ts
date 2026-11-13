// Task projects (phase 1 of 3): the pure name and slug rules in src/core/projects.ts. No store, no Clock.

import { describe, expect, it } from "vitest";
import { type CliAction, type LocalCliDeps, parseLocalCliArgs, runLocalCli } from "../src/core/local-cli.js";
import { MAX_PROJECT_NAME, MAX_PROJECT_SLUG, isProjectSlug, projectName, projectSlug } from "../src/core/projects.js";
import type { UserId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { newStore } from "./helpers/store.js";

describe("projectName", () => {
  it("trims the name and folds runs of whitespace to one space", () => {
    expect(projectName("  Home   renovation\t2027 ")).toEqual({ ok: true, name: "Home renovation 2027", slug: "home-renovation-2027" });
  });

  it("keeps the name as written and gives it its slug", () => {
    expect(projectName("Q3 Launch: Web & App")).toEqual({ ok: true, name: "Q3 Launch: Web & App", slug: "q3-launch-web-app" });
  });

  it("accepts a name of exactly the longest length", () => {
    const name = "a".repeat(MAX_PROJECT_NAME);
    expect(projectName(name)).toMatchObject({ ok: true, name });
  });

  it.each([
    ["an empty name", ""],
    ["a blank name", "   \t "],
    ["a name with a newline", "two\nlines"],
    ["a name with a control character", "bell\u0007"],
    ["a name longer than the limit", "a".repeat(MAX_PROJECT_NAME + 1)],
    ["a name with no letter or digit", "!!! ---"],
    ["a name that is not a string", 42 as unknown as string],
  ])("refuses %s with a reason", (_what, raw) => {
    const r = projectName(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/^a project name /);
  });
});

describe("projectSlug", () => {
  it("lowercases, joins words with one dash and drops leading and trailing dashes", () => {
    expect(projectSlug("--Hello,  World!--")).toBe("hello-world");
  });

  it("drops accents", () => {
    expect(projectSlug("Café Crème")).toBe("cafe-creme");
  });

  it("cuts a long slug at the limit without a trailing dash", () => {
    const slug = projectSlug(`${"a".repeat(MAX_PROJECT_SLUG - 1)} bbb`);
    expect(slug).toBe("a".repeat(MAX_PROJECT_SLUG - 1));
    expect(projectSlug("x".repeat(MAX_PROJECT_SLUG + 10))!.length).toBe(MAX_PROJECT_SLUG);
  });

  it("keeps letters and digits of any script", () => {
    expect(projectSlug("집 수리 2027")).toBe("집-수리-2027");
    expect(projectSlug("Ünïcode Straße")).toBe("unicode-straße");
  });

  it("is null for a name with no letter or digit", () => {
    expect(projectSlug("…")).toBeNull();
    expect(projectSlug(" - _ ! ")).toBeNull();
  });

  it("gives the same slug for names that differ only in case, spacing or punctuation", () => {
    expect(projectSlug("Home Repairs")).toBe(projectSlug("home-repairs"));
    expect(projectSlug("Home Repairs")).toBe(projectSlug(" HOME  repairs! "));
  });
});

describe("isProjectSlug", () => {
  it("accepts what projectSlug makes", () => {
    for (const name of ["Home", "Q3 Launch: Web & App", "Café Crème", "집 수리", "x".repeat(200)]) expect(isProjectSlug(projectSlug(name)!)).toBe(true);
  });

  it.each(["", "Home", "home repairs", "-home", "home-", "home--repairs", "home_repairs", "a".repeat(MAX_PROJECT_SLUG + 1)])("refuses %j", (s) => {
    expect(isProjectSlug(s)).toBe(false);
  });
});

// Task projects (phase 2 of 3): `factory project …`, `task project`, `+slug` in `task add` and `task edit`, and
// `task list`'s projects column and --project filter, over the store.

const USER = "local:dev@example.com" as UserId;

async function cliSetup() {
  const { store } = await newStore(new FakeClock("2026-11-14T09:00:00.000Z"));
  let n = 0;
  const d: LocalCliDeps = { store, identity: { user: USER, from: "git user.email" }, project: async () => null, read: async () => "", newId: () => `id${++n}` };
  /** As typed: `factory <word> <args...>`. */
  const run = async (word: string, ...args: string[]) => {
    const a = parseLocalCliArgs(word, args);
    if ("error" in a) throw new Error(a.error);
    return runLocalCli(d, a as CliAction);
  };
  const tasks = () => store.db.all("SELECT * FROM controller_tasks ORDER BY id");
  const links = () => store.db.all("SELECT task_id, project_id FROM controller_task_projects ORDER BY task_id, project_id");
  return { store, run, tasks, links };
}

describe("factory project", () => {
  it("create, list, rename, archive, restore and delete a project by its slug", async () => {
    const { run } = await cliSetup();
    expect(await run("project", "create", "Home", "Repairs")).toEqual({ code: 0, lines: ["+home-repairs\tHome Repairs"] });
    expect(await run("project", "create", "home  repairs!")).toEqual({ code: 1, lines: ['project "home-repairs" exists already'] });
    await run("project", "create", "Work");
    expect((await run("project", "list")).lines).toEqual(["+home-repairs\tHome Repairs", "+work\tWork"]);
    expect(await run("project", "rename", "work", "Day", "Job")).toEqual({ code: 0, lines: ["renamed +work to +day-job\tDay Job"] });
    expect(await run("project", "archive", "+day-job")).toEqual({ code: 0, lines: ["archived +day-job"] });
    expect((await run("project", "archive", "day-job")).lines).toEqual(["+day-job was already archived"]);
    expect((await run("project", "list")).lines).toEqual(["+home-repairs\tHome Repairs"]);
    expect((await run("project", "list", "--archived")).lines).toEqual(["+day-job\tDay Job\tarchived"]);
    expect((await run("project", "restore", "day-job")).lines).toEqual(["restored +day-job"]);
    expect((await run("project", "restore", "day-job")).lines).toEqual(["+day-job was already active"]);
    expect(await run("project", "delete", "day-job")).toEqual({ code: 0, lines: ["deleted +day-job"] });
    expect(await run("project", "delete", "day-job")).toEqual({ code: 1, lines: ['no project "day-job"'] });
    expect((await run("project", "list", "--archived")).lines).toEqual(["no archived projects"]);
  });

  it("refuses incomplete or unknown project commands before any read", () => {
    for (const args of [[], ["create"], ["list", "--all"], ["rename", "home"], ["archive"], ["delete", "a", "b"], ["restore", "!!"], ["move", "x"]]) {
      expect(parseLocalCliArgs("project", args), JSON.stringify(args)).toMatchObject({ error: expect.any(String) });
    }
  });
});

describe("+slug in task add and task edit", () => {
  it("task add +slug stores the task and its link; an unknown or archived project stores no task and no link", async () => {
    const { run, tasks, links } = await cliSetup();
    await run("project", "create", "Home");
    await run("project", "create", "Old");
    await run("project", "archive", "old");
    expect(await run("task", "add", "fix", "tap", "+nope")).toEqual({ code: 1, lines: ['no project "nope"'] });
    expect(await run("task", "add", "fix", "tap", "+home", "+Old")).toEqual({ code: 1, lines: ['project "old" is archived; restore it first'] });
    expect(await tasks()).toEqual([]);
    expect(await links()).toEqual([]);
    expect((await run("task", "add", "fix", "tap", "+Home")).code).toBe(0);
    expect(await links()).toEqual([{ task_id: "tk_id5", project_id: "pj_id1" }]);
  });

  it("task edit +slug adds the task to the project with the edit; a refused project writes no edit and no link", async () => {
    const { store, run, tasks, links } = await cliSetup();
    await run("project", "create", "Home");
    await run("task", "add", "fix", "tap");
    const before = await tasks();
    expect(await run("task", "edit", "tk_id2", "new", "title", "+nope")).toEqual({ code: 1, lines: ['no project "nope"'] });
    expect(await tasks()).toEqual(before);
    expect(await links()).toEqual([]);
    expect((await run("task", "edit", "tk_id2", "+home", "!1")).code).toBe(0);
    expect(await store.getTask("tk_id2")).toMatchObject({ title: "fix tap", priority: 1 });
    expect(await links()).toEqual([{ task_id: "tk_id2", project_id: "pj_id1" }]);
  });
});

describe("factory task project", () => {
  it("adds a task to a project and takes it out; each again changes nothing", async () => {
    const { run, links } = await cliSetup();
    await run("project", "create", "Home");
    await run("task", "add", "fix", "tap");
    expect(await run("task", "project", "tk_id2", "+home")).toEqual({ code: 0, lines: ["added tk_id2 to +home"] });
    expect((await run("task", "project", "tk_id2", "+Home")).lines).toEqual(["tk_id2 was already in +home"]);
    expect(await links()).toEqual([{ task_id: "tk_id2", project_id: "pj_id1" }]);
    expect(await run("task", "project", "tk_id2", "-home")).toEqual({ code: 0, lines: ["took tk_id2 out of +home"] });
    expect((await run("task", "project", "tk_id2", "-home")).lines).toEqual(["tk_id2 was not in +home"]);
    expect(await links()).toEqual([]);
  });

  it("refuses an unknown or archived project and an unknown task, linking nothing", async () => {
    const { run, links } = await cliSetup();
    await run("project", "create", "Old");
    await run("project", "archive", "old");
    await run("task", "add", "fix", "tap");
    expect(await run("task", "project", "tk_id2", "+nope")).toEqual({ code: 1, lines: ['no project "nope"'] });
    expect(await run("task", "project", "tk_id2", "+old")).toEqual({ code: 1, lines: ['project "old" is archived; restore it first'] });
    expect(await run("project", "create", "Home")).toMatchObject({ code: 0 });
    expect(await run("task", "project", "tk_nope", "+home")).toEqual({ code: 1, lines: ["no task tk_nope"] });
    expect(await links()).toEqual([]);
    for (const args of [["project", "tk_id2"], ["project", "tk_id2", "home"], ["project", "tk_id2", "+"], ["project", "tk_id2", "+a", "+b"]]) {
      expect(parseLocalCliArgs("task", args), JSON.stringify(args)).toMatchObject({ error: expect.any(String) });
    }
  });
});

describe("factory task list with projects", () => {
  it("prints the projects column after the list column: - for none, else +a,+b sorted", async () => {
    const { run } = await cliSetup();
    await run("project", "create", "Work");
    await run("project", "create", "Home");
    await run("task", "add", "fix", "tap", "+work", "+home", "#chores");
    await run("task", "add", "call", "mum");
    expect((await run("task", "list")).lines).toEqual(["no local work items", "", "Tasks", "tk_id3\tfix tap\t-\t-\t#chores\t+home,+work\t-", "tk_id4\tcall mum\t-\t-\t-\t-\t-"]);
  });

  it("--project lists only the open tasks in that project, its name read through projectSlug", async () => {
    const { run } = await cliSetup();
    await run("project", "create", "Home Repairs");
    await run("task", "add", "fix", "tap", "+home-repairs");
    await run("task", "add", "call", "mum");
    await run("task", "add", "paint", "wall", "+home-repairs");
    await run("task", "done", "tk_id4");
    expect(await run("task", "list", "--project", "Home Repairs")).toEqual({ code: 0, lines: ["tk_id2\tfix tap\t-\t-\t-\t+home-repairs\t-"] });
    await run("task", "done", "tk_id2");
    expect(await run("task", "list", "--project", "home-repairs")).toEqual({ code: 0, lines: ["no open tasks in +home-repairs"] });
  });

  it("--project with an unknown name exits 1 with the reason", async () => {
    const { run } = await cliSetup();
    expect(await run("task", "list", "--project", "nope")).toEqual({ code: 1, lines: ['no project "nope"'] });
    expect(parseLocalCliArgs("task", ["list", "--project"])).toMatchObject({ error: expect.stringContaining("--project <project_slug>") });
  });
});
