// Factory work follows the project switcher (design 09-dashboard-app): the store read that maps each work item to its
// source task's active projects, and GET /api/v1/items?project=<slug>, which keeps only the items built from that
// project's tasks. Without the parameter the items read is as before.

import { describe, expect, it, vi } from "vitest";
import { parseQuickAdd } from "../src/core/quick-add.js";
import { buildTask } from "../src/core/task-build.js";
import type { UserId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { HealthMonitor } from "../src/ui/health.js";
import { type ApiDeps, respond } from "../src/ui/server.js";
import { TASKS_PATH } from "../src/ui/tasks-api.js";
import { PROJECT_KEY, issue, newStore, system } from "./helpers/store.js";

const HOST = "127.0.0.1:4310";
const ACTOR = "local:owner@example.com" as UserId;

/**
 * Items: `both` from a task in Home and Demo, `home` from a task in Home and the archived Old, `old` from a task only
 * in Old, `bare` from a task in no project, and `plain`, an issue with no source task.
 */
async function seeded() {
  const clock = new FakeClock(new Date("2026-11-14T09:00:00"));
  const { store } = await newStore(clock);
  const d: ApiDeps = {
    store, clock, lease_ms: 300_000,
    scanner: new PatternEgressScanner(async () => []),
    health: new HealthMonitor(async () => [], clock),
  };
  for (const [id, name] of [["pj_home", "Home"], ["pj_demo", "Wonderful AI demo"], ["pj_old", "Old"]]) await store.createProject({ id: id!, name: name!, created_by: ACTOR });
  const build = async (task: string, projects: string[]) => {
    const parsed = parseQuickAdd(task);
    if (!parsed.ok) throw new Error(parsed.reason);
    await store.addTask({ ...parsed.task, id: `tk_${task}`, created_by: ACTOR });
    for (const p of projects) await store.addTaskToProject(p, `tk_${task}`);
    const r = await buildTask(store, `tk_${task}`, PROJECT_KEY, ACTOR);
    if (!r.ok) throw new Error(r.reason);
    return r.item.id;
  };
  const ids = {
    both: await build("both", ["pj_home", "pj_demo"]),
    home: await build("home", ["pj_home", "pj_old"]),
    old: await build("old", ["pj_old"]),
    bare: await build("bare", []),
    plain: (await store.createWorkItem(issue(7), system)).item.id,
  };
  await store.archiveProject("pj_old");
  const get = (query = "") => respond(d, { method: "GET", url: `/api/v1/items${query}`, host: HOST });
  const listed = async (query = "") => (JSON.parse((await get(query)).body).items as { id: string }[]).map((i) => i.id).sort();
  return { store, d, ids, get, listed };
}

describe("listWorkItemProjectSlugs", () => {
  it("maps each item to its source task's active project slugs, sorted, and leaves out items with no task or no active project", async () => {
    const s = await seeded();
    const all = Object.values(s.ids);
    expect(await s.store.listWorkItemProjectSlugs(all)).toEqual({ [s.ids.both]: ["home", "wonderful-ai-demo"], [s.ids.home]: ["home"] });
    expect(await s.store.listWorkItemProjectSlugs([])).toEqual({});
  });

  it("is one store query for the whole list", async () => {
    const s = await seeded();
    const all = vi.spyOn(s.store.db, "all");
    await s.store.listWorkItemProjectSlugs(Object.values(s.ids));
    expect(all).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/v1/items?project=<slug>", () => {
  it("lists only the items whose source task is in that project; an item from a task in two projects shows under each", async () => {
    const s = await seeded();
    expect(await s.listed("?project=home")).toEqual([s.ids.both, s.ids.home].sort());
    expect(await s.listed("?project=wonderful-ai-demo")).toEqual([s.ids.both]);
  });

  it("an item with no source task, or whose task has no project, shows under All only", async () => {
    const s = await seeded();
    const all = await s.listed();
    expect(all).toEqual(expect.arrayContaining([s.ids.plain, s.ids.bare]));
    for (const p of ["home", "wonderful-ai-demo"]) {
      const under = await s.listed(`?project=${p}`);
      expect(under).not.toContain(s.ids.plain);
      expect(under).not.toContain(s.ids.bare);
    }
  });

  it("counts active projects only: an item whose task's only project is archived shows under All only", async () => {
    const s = await seeded();
    expect(await s.listed()).toContain(s.ids.old);
    expect(await s.listed("?project=home")).not.toContain(s.ids.old);
    expect((await s.get("?project=old")).status).toBe(400);
  });

  it("without the parameter lists every open item, as before, and asks no project link", async () => {
    const s = await seeded();
    const links = vi.spyOn(s.store, "listWorkItemProjectSlugs");
    expect(await s.listed()).toEqual(Object.values(s.ids).sort());
    expect(links).not.toHaveBeenCalled();
  });

  it("refuses a value that is not a slug with 400, an unknown project with 404 and an archived one with 400, with the tasks read's messages", async () => {
    const s = await seeded();
    for (const query of ["?project=Not%20A%20Slug", "?project=", "?project=garden", "?project=old"]) {
      const items = await s.get(query);
      const tasks = await respond(s.d, { method: "GET", url: `${TASKS_PATH}${query}`, host: HOST });
      expect(items.status, query).toBe(tasks.status);
      expect(JSON.parse(items.body), query).toEqual(JSON.parse(tasks.body));
    }
    expect((await s.get("?project=garden")).status).toBe(404);
    expect(JSON.parse((await s.get("?project=old")).body).error).toBe('project "old" is archived; restore it first');
  });

  it("reads the project links in one store read for all listed items, with no read per item", async () => {
    const s = await seeded();
    const links = vi.spyOn(s.store, "listWorkItemProjectSlugs");
    const all = vi.spyOn(s.store.db, "all");
    const extra = async () => {
      all.mockClear();
      await s.get();
      const plain = all.mock.calls.length;
      all.mockClear();
      await s.get("?project=home");
      return all.mock.calls.length - plain;
    };
    const few = await extra();
    for (const n of [8, 9, 10]) await s.store.createWorkItem(issue(n), system);
    expect(await extra()).toBe(few);
    expect(links).toHaveBeenCalledTimes(2);
  });
});
