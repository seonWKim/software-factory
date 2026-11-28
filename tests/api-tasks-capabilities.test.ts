// The tasks capabilities (design 09-api-registry, 02-tasks): tasks.list (GET /api/v1/tasks) and tasks.create
// (POST /api/v1/tasks) are declared in src/api/capabilities/tasks.ts with a schema, a description and a permission;
// the hand-written entries are gone from src/ui/tasks-api.ts and src/ui/read-routes.ts. The Tasks page (its URL
// unchanged), the quick-add box and `factory task add` all store a task through the store's addTask, and the page
// reads through the capability that tasks.list runs.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REGISTRY } from "../src/api/index.js";
import { registryReads, registryWrites } from "../src/api/registry.js";
import { type CliAction, parseLocalCliArgs, runLocalCli } from "../src/core/local-cli.js";
import type { UserId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { answersDetail, splitAnswers } from "../src/shared/command-notes.js";
import { HealthMonitor } from "../src/ui/health.js";
import { type ApiDeps, respond } from "../src/ui/server.js";
import { newCsrfToken } from "../src/ui/settings-api.js";
import { TASK_WRITES } from "../src/ui/tasks-api.js";
import { silent } from "./helpers/fakes/config.js";
import { newStore } from "./helpers/store.js";

const REPO = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(REPO, p), "utf8");
/** Text with its comments blanked. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/gm, "$1");

const PATH = "/api/v1/tasks";
const HOST = "127.0.0.1:4310";
const ACTOR = "local:owner@example.com" as UserId;

describe("tasks.list and tasks.create", () => {
  it("are declared with a schema, a description and a permission: tasks.list a read, tasks.create an owner write", () => {
    const list = REGISTRY.capabilities.find((c) => c.id === "tasks.list");
    const create = REGISTRY.capabilities.find((c) => c.id === "tasks.create");
    expect(list).toMatchObject({ method: "GET", path: PATH, permission: "read", area: "tasks" });
    expect(create).toMatchObject({ method: "POST", path: PATH, permission: "owner", area: "tasks" });
    for (const c of [list!, create!]) {
      expect(c.description.trim()).not.toBe("");
      expect(typeof c.input.json).toBe("function");
      expect(typeof c.output.json).toBe("function");
    }
    expect(Object.keys(create!.input.fields).sort()).toEqual(["id", "project", "words"]);
    expect(registryReads(REGISTRY, PATH)).toBe(true);
    expect(registryWrites(REGISTRY, PATH)).toBe(true);
  });

  it("are declared in src/api/capabilities/tasks.ts, and the hand-written entries are gone from tasks-api.ts and read-routes.ts", () => {
    expect(code(read("src/api/capabilities/tasks.ts"))).toMatch(/id: "tasks\.list"[\s\S]*id: "tasks\.create"/);
    expect(Object.keys(TASK_WRITES)).not.toContain(PATH);
    expect(code(read("src/ui/read-routes.ts"))).not.toMatch(/\breadTasks\b|\bTASKS_PATH\b/);
    expect(code(read("src/ui/tasks-api.ts"))).not.toMatch(/\[TASKS_PATH\]/);
  });
});

/** A store whose addTask calls are counted, served as the Tasks page serves it. */
async function served() {
  const clock = new FakeClock(new Date("2026-11-28T09:00:00"));
  const { store } = await newStore(clock);
  const added: string[] = [];
  const counted = new Proxy(store, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      if (prop === "addTask") return (t: Parameters<FactoryStore["addTask"]>[0]) => (added.push(t.id), store.addTask(t));
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  const token = newCsrfToken();
  const d: ApiDeps = {
    store: counted, scanner: new PatternEgressScanner(async () => []), clock, lease_ms: 300_000, health: new HealthMonitor(async () => [], clock),
    commands: { actor: ACTOR, source: "environment", token },
    pauses: { principal: async () => ACTOR, authorize: async () => ({ allow: true }), csrfToken: token, log: silent },
  };
  const post = (body: unknown) => respond(d, { method: "POST", url: PATH, host: HOST, origin: `http://${HOST}`, contentType: "application/json", csrfToken: token, body: JSON.stringify(body) });
  const get = async (url = PATH) => respond(d, { method: "GET", url, host: HOST });
  return { store: counted, added, post, get };
}

describe("the Tasks page, the quick-add box and factory task add", () => {
  it("store a task through the store's addTask, and the page reads it back at its same URL", async () => {
    const s = await served();
    // The Tasks page's and the desktop shell's quick-add box: POST /api/v1/tasks, the registry's tasks.create.
    expect((await s.post({ id: "tk_page_0001", words: "pay rent tomorrow #home" })).status).toBe(200);
    // `factory task add`.
    let n = 0;
    const a = parseLocalCliArgs("task", ["add", "water", "plants"]);
    if ("error" in a) throw new Error(a.error);
    const cli = await runLocalCli({
      answers: { split: splitAnswers, detail: answersDetail }, store: s.store, identity: { user: ACTOR, from: "git user.email" }, project: async () => null, read: async () => "", newId: () => `cli_${++n}`,
    }, a as CliAction);
    expect(cli.code).toBe(0);
    expect(s.added).toEqual(["tk_page_0001", "tk_cli_1"]);

    // The page's read: GET /api/v1/tasks, the registry's tasks.list, answers both.
    const r = await s.get();
    expect(r.status).toBe(200);
    expect(r.body).toContain("tk_page_0001");
    expect(r.body).toContain("tk_cli_1");
    expect(JSON.parse(r.body)).toMatchObject({ csrf_token: expect.any(String), today_date: "2026-11-28" });
    // ?project=<slug> stays the project switcher's URL: an unknown project is 404.
    expect((await s.get(`${PATH}?project=nope`)).status).toBe(404);
  });

  it("the same quick-add ID sent twice stores one task", async () => {
    const s = await served();
    for (let i = 0; i < 2; i++) expect((await s.post({ id: "tk_page_0002", words: "call mum" })).status).toBe(200);
    expect((await s.store.listTasks(100)).map((t) => t.id)).toEqual(["tk_page_0002"]);
  });
});
