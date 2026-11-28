import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectAlarms } from "../src/core/alarms.js";
import { ALARM_DEFAULTS, type FactoryConfig } from "../src/core/config.js";
import { WORKER_KINDS } from "../src/core/settings.js";
import type { Run, RunOutcome, UserId, WorkItem, WorkItemPatch, WorkerId } from "../src/core/types.js";
import type { NewRun } from "../src/interfaces/factory-store.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { HealthMonitor } from "../src/ui/health.js";
import { SCREENSHOT_PATH } from "../src/ui/item-screenshots.js";
import type { UiDeps } from "../src/ui/server.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { CAPTURE_ENV, captureEnv, chromeBrowser } from "../src/shared/chrome-browser.js";
import {
  type BrowserSession, CaptureUnavailable, type RunExec, SCREENSHOT_SIZES, SCREENSHOT_THEMES, type ScreenshotBrowser, captureAll, capturePages, parseScreenshotReview,
  screenshotKey, sectionNotShownLine,
} from "../src/shared/screenshots.js";
import { Worker } from "../src/worker/index.js";
import { loadRunKinds } from "../src/worker/run-kind.js";
import { BUILD_COMMAND, screenshotRun } from "../src/worker/runs/screenshot/screenshot.run.js";
import { FakeBroker } from "./helpers/fakes/broker.js";
import { cleanScanner, config, prompts, silent } from "./helpers/fakes/config.js";
import { FakeAuth, FakeRunner, FakeSandbox, MemoryStorage } from "./helpers/fakes/runner.js";
import { FakeSource } from "./helpers/fakes/source.js";
import { PROJECT_KEY, newStore } from "./helpers/store.js";
import { SECRET, get, json, make } from "./ui-api-fixtures.js";

// Screenshots of changed pages before merge (design 04-screenshots): a passing review of a change under a
// `repo.ui_check` path queues one screenshot run; it captures the fixture dashboard's pages at 390px and 1280px in
// light and dark into shared storage; one screenshot review follows and posts one comment. No step changes a stage,
// blocked_on or blocked_reason. A fake browser and memory storage stand in: no test starts a real Chrome.

const UI = { command: ["npm", "run", "-s", "check:responsive"], paths: ["web/", "src/ui/"] };
const actor = { kind: "system" as const, id: "system:test" };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const PAGES_TS = `export const PAGES = [\n  { path: "", label: "Floor" },\n  { path: "items", label: "Work" },\n  { path: "settings", label: "Settings" },\n];\n`;

/** A browser on a fake fixture: records the exec it opened on and what it shot; `failAt` fails that shot (1-based), `refuse` fails the open. */
function fakeBrowser(o: { failAt?: number; refuse?: Error } = {}) {
  const opened: RunExec[] = [];
  const shots: string[] = [];
  let closed = 0;
  const browser: ScreenshotBrowser = {
    async open(exec) {
      if (o.refuse) throw o.refuse;
      opened.push(exec);
      const session: BrowserSession = {
        pages: capturePages(PAGES_TS),
        async shoot(page, at) {
          shots.push(`${page.path}@${at.width}x${at.height}:${at.theme}`);
          if (shots.length === o.failAt) throw new Error("Page.captureScreenshot: target closed\nstack");
          return PNG;
        },
        async close() {
          closed++;
        },
      };
      return session;
    },
  };
  return { browser, opened, shots, closed: () => closed };
}

const signal = new AbortController().signal;
/** An exec that is never called (the fake browser runs nothing). */
const noExec: RunExec = async () => ({ exit_code: 0, stdout: "", stderr: "" });

describe("the capture set", () => {
  it("is every sidebar page, then the item page and the transcript page, each at 390px and 1280px in light and dark", async () => {
    const f = fakeBrowser();
    const storage = new MemoryStorage();
    const out = await captureAll(f.browser, storage, { item_id: "it1", run_id: "run1", exec: noExec, signal });
    expect(out.reason).toBeNull();
    const pages = ["floor", "items", "settings", "item", "transcript", "settings-integrations", "settings-advanced"];
    expect([...new Set(out.captures.map((c) => c.page))]).toEqual(pages);
    for (const page of pages) {
      expect(out.captures.filter((c) => c.page === page).map((c) => `${c.width}-${c.theme}`)).toEqual(["390-light", "390-dark", "1280-light", "1280-dark"]);
    }
    expect(out.captures.find((c) => c.page === "item")).toMatchObject({ key: "it1/run1/item-390-light.png" });
    expect([...storage.data.keys()]).toEqual(out.captures.map((c) => c.key));
    // The item and transcript pages are the fixture's (the capture script fills its IDs), at the heights check:responsive uses.
    expect(f.shots).toContain("items/:item@390x844:light");
    expect(f.shots).toContain("items/:item/runs/:run@1280x800:dark");
    expect(f.opened).toEqual([noExec]);
    expect(f.closed()).toBe(1);
  });

  it("the four captures are fixed: two widths and two themes, no setting", () => {
    expect(SCREENSHOT_SIZES.map((s) => s.width)).toEqual([390, 1280]);
    expect([...SCREENSHOT_THEMES]).toEqual(["light", "dark"]);
    expect(screenshotKey("it", "run", "settings", 1280, "dark")).toBe("it/run/settings-1280-dark.png");
  });

  it("captures the whole page: laid out at the fixed height, then the window grows to the content's full height", async () => {
    const script = await readFile(join(import.meta.dirname, "..", "scripts", "responsive", "capture.mjs"), "utf8");
    const at = (s: string) => script.indexOf(s);
    expect(script).toContain("[data-scroll-root]");
    expect(at("metrics(shoot.height)")).toBeGreaterThan(-1);
    // In order: the fixed height for layout, the page, its full height measured, the window grown to it, the capture with it as the clip.
    const steps = ["metrics(shoot.height)", "page.goto(", "page.eval(FULL_HEIGHT)", "metrics(full)", "height: full", "Page.captureScreenshot"].map(at);
    expect(steps.every((s) => s > -1)).toBe(true);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
  });

  it("the fixture seeds rules on (applied and waiting rules) and one standing approval with three approved items", async () => {
    const fixture = await readFile(join(import.meta.dirname, "..", "scripts", "responsive", "fixture.mjs"), "utf8");
    expect(fixture).toMatch(/AGENTS_HOME/);
    expect(fixture).toMatch(/## tacit Pending/);
    expect(fixture).toMatch(/## proposals \(open\)/);
    expect(fixture).toMatch(/- 기본값: /);
    expect(fixture).toMatch(/putStandingRule\(/);
    expect(fixture).toMatch(/STANDING_APPROVED/);
    expect(fixture).toMatch(/STANDING_ITEMS = 3/);
  });

  it("reads the sidebar pages from the checkout's web/src/pages.ts, as check:responsive does", async () => {
    const real = await readFile(join(import.meta.dirname, "..", "web", "src", "pages.ts"), "utf8");
    const pages = capturePages(real).map((p) => p.name);
    expect(pages).toEqual(expect.arrayContaining(["items", "settings", "item", "transcript"]));
    // Every sidebar page keeps its default-URL capture, then the item and transcript pages, as before the tabs.
    expect(pages.indexOf("transcript")).toBe(pages.indexOf("item") + 1);
    expect(pages.slice(0, pages.indexOf("item"))).not.toContain("item");
  });

  it("adds one capture per non-default tab of each tabbed page, named <page>-<tab>, and the Evals dialog last", async () => {
    const real = await readFile(join(import.meta.dirname, "..", "web", "src", "pages.ts"), "utf8");
    const pages = capturePages(real);
    const named = new Map(pages.map((p) => [p.name, p]));
    const tabs = ["calendar-schedules", "settings-integrations", "settings-advanced", "plugins-skills", "plugins-tools", "plugins-models", "health-runs", "health-cost", "health-review"];
    expect(tabs.every((n) => named.has(n))).toBe(true);
    expect(named.get("settings-integrations")).toEqual({ name: "settings-integrations", path: "settings?tab=integrations" });
    expect(named.get("plugins-skills")?.open).toBeUndefined();
    // A page's default tab keeps its existing capture and gets no second one.
    expect(["settings-general", "plugins-mcp", "health-overview"].some((n) => named.has(n))).toBe(false);
    expect(named.get("plugins-skills-evals")).toEqual({ name: "plugins-skills-evals", path: "plugins?tab=skills", open: "evals" });
    // A dialog on a tab is named <page>-<tab>-<dialog>.
    expect(named.get("calendar-schedules-new-schedule")).toEqual({ name: "calendar-schedules-new-schedule", path: "calendar?tab=schedules", open: "new-schedule" });
    expect(pages.at(-1)?.name).toBe("plugins-skills-evals");
    // A checkout whose sidebar lacks a tabbed page has none of its tabs; a page with no tabs gains nothing.
    expect(capturePages(PAGES_TS).map((p) => p.name).filter((n) => n.startsWith("plugins") || n.startsWith("health"))).toEqual([]);
    expect(capturePages(PAGES_TS).filter((p) => p.path === "items" || p.path === "")).toEqual([{ name: "floor", path: "" }, { name: "items", path: "items" }]);
  });

  it("the Evals dialog is captured at 390 and 1280, light and dark, under its own name", async () => {
    const real = await readFile(join(import.meta.dirname, "..", "web", "src", "pages.ts"), "utf8");
    const session: BrowserSession = { pages: capturePages(real), async shoot() { return PNG; }, async close() {} };
    const out = await captureAll({ async open() { return session; } }, new MemoryStorage(), { item_id: "it1", run_id: "run1", exec: noExec, signal });
    expect(out.reason).toBeNull();
    for (const page of ["settings-integrations", "plugins-skills", "plugins-skills-evals"]) {
      expect(out.captures.filter((c) => c.page === page).map((c) => `${c.width}-${c.theme}`)).toEqual(["390-light", "390-dark", "1280-light", "1280-dark"]);
    }
    // The tab and its dialog differ in the key's page name, so neither overwrites the other.
    expect(out.captures.find((c) => c.page === "plugins-skills-evals")?.key).toBe("it1/run1/plugins-skills-evals-390-light.png");
  });

  it("a shot with an open step carries it to the capture script, which clicks the marked button and fails the shot when no dialog opens", async () => {
    const script = await readFile(join(import.meta.dirname, "..", "scripts", "responsive", "capture.mjs"), "utf8");
    expect(script).toContain("data-capture-open");
    expect(script).toContain("dialog[open]");
    expect(script).toMatch(/did not open/);
    // The step runs after the page is drawn and before its full height is measured.
    expect(script.indexOf("openDialog(page, shoot.open)")).toBeGreaterThan(script.indexOf("page.goto("));
    expect(script.indexOf("openDialog(page, shoot.open)")).toBeLessThan(script.indexOf("page.eval(FULL_HEIGHT)"));
    const real = await readFile(join(import.meta.dirname, "..", "web", "src", "views", "plugins.tsx"), "utf8");
    expect(real).toContain('data-capture-open="evals"');
    const schedules = await readFile(join(import.meta.dirname, "..", "web", "src", "views", "schedules.tsx"), "utf8");
    expect(schedules).toContain('data-capture-open="new-schedule"');
  });

  it("the fixture seeds one imported skill with a SKILL.md and an eval suite, so the Skills tab has a row with Evals", async () => {
    const fixture = await readFile(join(import.meta.dirname, "..", "scripts", "responsive", "fixture.mjs"), "utf8");
    expect(fixture).toMatch(/SKILL\.md/);
    expect(fixture).toMatch(/SkillRefsStore/);
    expect(fixture).toMatch(/createSkillEvalSuite\(/);
  });

  it("the fixture seeds schedules, so the Schedules rows have the ⋯ menu check:responsive opens as menu-row", async () => {
    const fixture = await readFile(join(import.meta.dirname, "..", "scripts", "responsive", "fixture.mjs"), "utf8");
    expect(fixture).toMatch(/await seedSchedules\(store\)/);
    expect(fixture).toMatch(/writeSchedule\(store, "add"/);
    const check = await readFile(join(import.meta.dirname, "..", "scripts", "responsive-check.mjs"), "utf8");
    expect(check).toContain('{ name: "menu-row", path: "schedules" }');
    // The Routines page is gone (design 09-dashboard-routines): neither the fixture nor the check open it.
    expect(fixture).not.toMatch(/seedRoutines|writeRoutine/);
    expect(check).not.toContain('path: "routines"');
  });
});

describe("a capture that fails", () => {
  it("ends with the captures it has and a reason, and closes the browser", async () => {
    const f = fakeBrowser({ failAt: 3 });
    const storage = new MemoryStorage();
    const out = await captureAll(f.browser, storage, { item_id: "it1", run_id: "run1", exec: noExec, signal });
    expect(out.captures.map((c) => c.key)).toEqual(["it1/run1/floor-390-light.png", "it1/run1/floor-390-dark.png"]);
    expect(out.reason).toBe("the capture of floor at 1280px, light failed: Page.captureScreenshot: target closed");
    expect(storage.data.size).toBe(out.captures.length);
    expect(f.closed()).toBe(1);
  });

  it("a browser that cannot start (no Chrome) gives its reason and no capture", async () => {
    const out = await captureAll(fakeBrowser({ refuse: new CaptureUnavailable("Chrome is not installed on this worker") }).browser, new MemoryStorage(), { item_id: "i", run_id: "r", exec: noExec, signal });
    expect(out).toEqual({ captures: [], reason: "Chrome is not installed on this worker" });
  });
});

describe("the Chrome browser", () => {
  /**
   * An exec standing in for the run's sandbox: records every command; `test -f` finds the script when `script` is set,
   * `cat` prints PAGES_TS, and the capture script's stdout is `script` given the stdin.
   */
  function sandboxExec(script: ((stdin: string) => string) | null) {
    const calls: { cmd: string; env: Readonly<Record<string, string>>; stdin: string | undefined }[] = [];
    const exec: RunExec = async (cmd, o) => {
      calls.push({ cmd: cmd.join(" "), env: o.env, stdin: o.stdin });
      if (cmd[0] === "test") return { exit_code: script ? 0 : 1, stdout: "", stderr: "" };
      if (cmd[0] === "cat") return { exit_code: 0, stdout: PAGES_TS, stderr: "" };
      return { exit_code: 0, stdout: script!(o.stdin ?? ""), stderr: "" };
    };
    return { exec, calls };
  }
  const line = (m: unknown) => `${JSON.stringify(m)}\n`;

  it("passes the capture script only the env Chrome needs: no token or secret", async () => {
    const env = captureEnv({ PATH: "/usr/bin", HOME: "/home/o", GITHUB_TOKEN: "ghp_x", ANTHROPIC_API_KEY: "sk-x", SF_SECRET: "s", CHROME_PATH: "/c" });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/o", CHROME_PATH: "/c" });
    expect(CAPTURE_ENV.some((k) => /TOKEN|KEY|SECRET|PASSWORD/.test(k))).toBe(false);
    const s = sandboxExec(() => line({ ready: true }));
    await captureAll(chromeBrowser({ PATH: "/usr/bin", GITHUB_TOKEN: "ghp_x" }), new MemoryStorage(), { item_id: "i", run_id: "r", exec: s.exec, signal });
    expect(s.calls.map((c) => c.env)).toEqual(s.calls.map(() => ({ PATH: "/usr/bin" })));
  });

  it("runs every command through the run's exec, the capture once with the fixed shots on stdin, one PNG line per shot", async () => {
    const s = sandboxExec((stdin) => line({ ready: true }) + stdin.trim().split("\n").map((l) => {
      const { shoot } = JSON.parse(l) as { shoot: { path: string; width: number; theme: string } };
      return line(shoot.path === "settings" ? { error: "boom" } : { png: Buffer.from(`${shoot.path}@${shoot.width}${shoot.theme}`).toString("base64") });
    }).join(""));
    const storage = new MemoryStorage();
    const out = await captureAll(chromeBrowser(), storage, { item_id: "i", run_id: "r", exec: s.exec, signal });
    expect(s.calls.map((c) => c.cmd)).toEqual(["test -f scripts/responsive/capture.mjs", "cat web/src/pages.ts", "node --disable-warning=ExperimentalWarning scripts/responsive/capture.mjs"]);
    const shots = s.calls[2]!.stdin!.trim().split("\n").map((l) => JSON.parse(l) as { shoot: { path: string } });
    expect(shots.map((x) => x.shoot.path)).toEqual(expect.arrayContaining(["", "items", "settings", "items/:item", "items/:item/runs/:run", "settings?tab=integrations"]));
    expect(out.captures.map((c) => c.page)).toEqual(["floor", "floor", "floor", "floor", "items", "items", "items", "items"]);
    expect(out.reason).toBe("the capture of settings at 390px, light failed: boom");
    expect(Buffer.from(storage.data.get("i/r/items-1280-dark.png")!).toString()).toBe("items@1280dark");
  });

  it("sends a dialog shot's open step on stdin; a dialog that does not open fails that shot with its reason and keeps the captures before it", async () => {
    const real = await readFile(join(import.meta.dirname, "..", "web", "src", "pages.ts"), "utf8");
    let stdin = "";
    const exec: RunExec = async (cmd, o) => {
      if (cmd[0] === "test") return { exit_code: 0, stdout: "", stderr: "" };
      if (cmd[0] === "cat") return { exit_code: 0, stdout: real, stderr: "" };
      stdin = o.stdin ?? "";
      const replies = stdin.trim().split("\n").map((l) => {
        const { shoot } = JSON.parse(l) as { shoot: { open?: string } };
        return line(shoot.open === "evals" ? { error: `the ${shoot.open} dialog did not open` } : { png: Buffer.from("x").toString("base64") });
      });
      return { exit_code: 0, stdout: line({ ready: true }) + replies.join(""), stderr: "" };
    };
    const out = await captureAll(chromeBrowser(), new MemoryStorage(), { item_id: "i", run_id: "r", exec, signal });
    const sent = stdin.trim().split("\n").map((l) => (JSON.parse(l) as { shoot: { path: string; open?: string } }).shoot);
    expect(sent.filter((x) => x.open).map((x) => `${x.path}:${x.open}`)).toEqual([...Array(4).fill("calendar?tab=schedules:new-schedule"), ...Array(4).fill("plugins?tab=skills:evals")]);
    expect(sent.filter((x) => !x.open).every((x) => !("open" in x))).toBe(true);
    expect(out.reason).toBe("the capture of plugins-skills-evals at 390px, light failed: the evals dialog did not open");
    expect(out.captures.map((c) => c.page)).toContain("plugins-skills");
    expect(out.captures.map((c) => c.page)).toContain("calendar-schedules-new-schedule");
    expect(out.captures.map((c) => c.page)).not.toContain("plugins-skills-evals");
  });

  it("a script that reports Chrome missing, a checkout with no script, or a script that stops short is a reason", async () => {
    const missing = sandboxExec(() => line({ error: "Chrome is not installed on this worker (set CHROME_PATH)", unavailable: true }));
    expect(await captureAll(chromeBrowser(), new MemoryStorage(), { item_id: "i", run_id: "r", exec: missing.exec, signal })).toEqual({
      captures: [], reason: "Chrome is not installed on this worker (set CHROME_PATH)",
    });
    const none = sandboxExec(null);
    expect((await captureAll(chromeBrowser(), new MemoryStorage(), { item_id: "i", run_id: "r", exec: none.exec, signal })).reason).toBe("the checkout has no scripts/responsive/capture.mjs");
    const short = sandboxExec(() => line({ ready: true }) + line({ png: Buffer.from("x").toString("base64") }));
    const out = await captureAll(chromeBrowser(), new MemoryStorage(), { item_id: "i", run_id: "r", exec: short.exec, signal });
    expect(out.captures).toHaveLength(1);
    expect(out.reason).toBe("the capture of floor at 390px, dark failed: the capture script exited");
  });

  it("the capture script seeds the fixture store only and writes no file in the repository or .playwright-mcp/", async () => {
    const text = await readFile(join(import.meta.dirname, "..", "scripts", "responsive", "capture.mjs"), "utf8");
    expect(text).toMatch(/import\("\.\/fixture\.mjs"\)/);
    expect(text).not.toMatch(/factory\.config|\.factory\/|\.playwright-mcp|writeFile/);
  });

  it("is never a host process: no child_process import", async () => {
    const text = await readFile(join(import.meta.dirname, "..", "src", "shared", "chrome-browser.ts"), "utf8");
    expect(text).not.toMatch(/child_process|spawn\(/);
  });
});

/** A store, a controller and a worker whose screenshot runs use Chrome, the default; the fake sandbox has no capture script. */
async function harness(o: { ui_check?: FactoryConfig["repo"]["ui_check"] | null; exits?: Record<string, number> } = {}) {
  const { store, clock } = await newStore();
  const ui = o.ui_check === null ? {} : { ui_check: o.ui_check ?? UI };
  const cfg: FactoryConfig = { ...config, repo: { ...config.repo, ...ui } };
  const controller = new ControllerRole({ store, sources: [new FakeSource()], auth: new FakeAuth(), clock, config: cfg, log: silent, scanner: cleanScanner });
  const sandbox = new FakeSandbox();
  Object.assign(sandbox.exits, { "test -f scripts/responsive/capture.mjs": 1 }, o.exits ?? {});
  const runner = new FakeRunner({ review: () => ({ output: { verdict: "pass", tier: 2, findings: [{ kind: "code", text: "breaks decision rule 1 on items at 390px, dark" }], summary: "one rule" } }) });
  const storage = new MemoryStorage();
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox, runner, broker: new FakeBroker(), storage, clock, config: cfg, prompts, log: silent, scanner: cleanScanner,
    toolEnv: {}, awake: new NoKeepAwake(),
  });
  const inReview = async (patch: WorkItemPatch = {}): Promise<WorkItem> => {
    const { item } = await store.createWorkItem({ source: { type: "local", id: "local-1", link: "local:local-1" }, requester_id: "local:me" as UserId, project: PROJECT_KEY, problem: "p", resources: [] }, actor);
    const r = await store.transition({ id: item.id, expected_version: item.version, actor, reason: "setup", patch: { stage: "REVIEW", tier: 2, pr_files: ["web/src/views/pages.tsx"], ...patch } });
    if (!r.ok) throw new Error("setup failed");
    return r.item;
  };
  /** Claims the queued run of `kind` and finishes it with `outcome`. */
  const finish = async (kind: Run["kind"], outcome: RunOutcome): Promise<Run> => {
    const run = await store.claimRun({ worker_id: "w9" as WorkerId, kinds: [kind], lease_ms: 60_000 });
    if (!run) throw new Error(`no ${kind} run queued`);
    await store.completeRun(run.id, run.lease!.token, outcome);
    return run;
  };
  const review = async (it: WorkItem, verdict: "pass" | "bug", findings: unknown[] = []) => {
    await store.enqueueRun({ work_item_id: it.id, kind: "review", idempotency_key: `${it.id}:review:test` });
    const run = await finish("review", { status: "succeeded", summary: "", data: { review: { verdict, tier: 2, findings, summary: "s" }, head_sha: "h1" } });
    await controller.tickRuns();
    return run;
  };
  const runs = async (it: WorkItem, kind: Run["kind"]) => (await store.listRuns(it.id)).filter((r) => r.kind === kind);
  const comments = async (it: WorkItem) => (await store.listItemMessages(it.id)).filter((m) => m.marker.startsWith("<!-- factory:screenshot-review:")).map((m) => m.body);
  const state = async (it: WorkItem) => {
    const x = (await store.getWorkItem(it.id))!;
    return { stage: x.stage, blocked_on: x.blocked_on, blocked_reason: x.blocked_reason };
  };
  return { store, cfg, controller, worker, sandbox, runner, storage, inReview, finish, review, runs, comments, state };
}

describe("the trigger after a review", () => {
  it("a passing review of a change under a repo.ui_check path queues one screenshot run, keyed on the item and the review", async () => {
    const h = await harness();
    const it1 = await h.inReview();
    const rev = await h.review(it1, "pass");
    const shots = await h.runs(it1, "screenshot");
    expect(shots).toHaveLength(1);
    expect(shots[0]).toMatchObject({ status: "queued", idempotency_key: `${it1.id}:screenshot:${rev.id}`, input: { review_run_id: rev.id } });
    // Applying the same review again queues nothing more.
    await h.controller.tickRuns();
    expect(await h.runs(it1, "screenshot")).toHaveLength(1);
  });

  it("a bug verdict, a spec finding, a change outside the UI paths, no pr_files or no repo.ui_check queues none", async () => {
    const cases: [string, Parameters<typeof harness>[0], WorkItemPatch, "pass" | "bug", unknown[]][] = [
      ["bug", {}, {}, "bug", [{ kind: "code", text: "x" }]],
      ["spec finding", {}, {}, "pass", [{ kind: "spec", text: "needs a file" }]],
      ["outside", {}, { pr_files: ["src/core/policy.ts", "docs/design.md"] }, "pass", []],
      ["no pr_files", {}, { pr_files: null }, "pass", []],
      ["no ui_check", { ui_check: null }, {}, "pass", []],
    ];
    for (const [name, opts, patch, verdict, findings] of cases) {
      const h = await harness(opts);
      const it1 = await h.inReview(patch);
      await h.review(it1, verdict, findings);
      expect(await h.runs(it1, "screenshot"), name).toEqual([]);
    }
  });

  it("the paths are repo.ui_check's", async () => {
    const h = await harness({ ui_check: { command: ["x"], paths: ["app/"] } });
    const it1 = await h.inReview({ pr_files: ["app/page.tsx"] });
    await h.review(it1, "pass");
    expect(await h.runs(it1, "screenshot")).toHaveLength(1);
  });
});

describe("the screenshot run and its review", () => {
  it("is a run kind every worker claims, with its run file, in a folder", async () => {
    expect(WORKER_KINDS).toContain("screenshot");
    expect((await loadRunKinds()).get("screenshot")).toMatchObject({ name: "screenshot", folder: true });
  });

  it("builds the branch, then captures with the browser it is handed", async () => {
    const h = await harness();
    const it1 = await h.inReview();
    await h.review(it1, "pass");
    const run = (await h.store.claimRun({ worker_id: "w1" as WorkerId, kinds: ["screenshot"], lease_ms: 60_000 }))!;
    const handle = await h.sandbox.create({ repo: "/repo", branch: "factory/x", base_ref: "main" });
    const f = fakeBrowser();
    const kind = screenshotRun(f.browser);
    const data = await kind.execute(h.worker, { run, item: it1, ctx: {} as never, signal, model: "cheap", step: (_id, fn) => fn({} as never), handle });
    expect(h.sandbox.commands).toEqual(expect.arrayContaining(["npm ci", BUILD_COMMAND.join(" ")]));
    // The browser's commands go to the run's sandbox, on its handle.
    expect(f.opened).toHaveLength(1);
    await f.opened[0]!(["echo", "in-sandbox"], { env: {} });
    expect(h.sandbox.commands).toContain("echo in-sandbox");
    expect(data).toMatchObject({ reason: null, review_run_id: run.input?.review_run_id });
    expect((data.captures as unknown[]).length).toBe(capturePages(PAGES_TS).length * 4);
    expect([...h.storage.data.keys()].every((k) => k.startsWith(`${it1.id}/${run.id}/`))).toBe(true);
  });

  it("a failed build is a reason, never a run failure, and captures nothing", async () => {
    const h = await harness({ exits: { [BUILD_COMMAND.join(" ")]: 1 } });
    const it1 = await h.inReview();
    await h.review(it1, "pass");
    const run = (await h.store.claimRun({ worker_id: "w1" as WorkerId, kinds: ["screenshot"], lease_ms: 60_000 }))!;
    const handle = await h.sandbox.create({ repo: "/repo", branch: "factory/x", base_ref: "main" });
    const f = fakeBrowser();
    const data = await screenshotRun(f.browser).execute(h.worker, { run, item: it1, ctx: {} as never, signal, model: "cheap", step: (_id, fn) => fn({} as never), handle });
    expect(data).toMatchObject({ captures: [], reason: expect.stringMatching(/^the build failed/) });
    expect(f.opened).toEqual([]);
  });

  it("with no Chrome: the run ends with its reason, one screenshot review lists it as not captured and posts one comment; no state changes", async () => {
    const h = await harness();
    const it1 = await h.inReview();
    await h.review(it1, "pass");
    const before = await h.state(it1);
    // The worker's screenshot run: Chrome's browser, through the sandbox, finds no capture script in the fake folder.
    while (await h.worker.tick()) await h.controller.tickRuns();
    await h.controller.tickRuns();
    const [shot] = await h.runs(it1, "screenshot");
    expect(shot).toMatchObject({ status: "succeeded", outcome: { data: { captures: [], reason: "the checkout has no scripts/responsive/capture.mjs" } } });
    const followUp = (await h.runs(it1, "review")).filter((r) => r.input?.screenshot_review === true);
    expect(followUp).toHaveLength(1);
    expect(followUp[0]).toMatchObject({
      idempotency_key: `${it1.id}:review:screenshots:${shot!.id}`,
      input: { screenshot_review: true, screenshot_run_id: shot!.id, screenshots: { captures: [], reason: "the checkout has no scripts/responsive/capture.mjs" } },
    });
    // No agent ran for a review with nothing to look at.
    expect(h.runner.specs).toEqual([]);
    const [comment, ...more] = await h.comments(it1);
    expect(more).toEqual([]);
    expect(comment).toContain("- screenshots not captured: the checkout has no scripts/responsive/capture.mjs");
    expect(await h.state(it1)).toEqual(before);
    // Every run is acknowledged; nothing else is queued.
    expect((await h.store.listUnacknowledgedRuns(20)).filter((r) => r.work_item_id === it1.id)).toEqual([]);
  });

  it("with captures: the reviewer gets the images and its findings post as one comment of kind code; no state changes", async () => {
    const h = await harness();
    const it1 = await h.inReview();
    await h.review(it1, "pass");
    const before = await h.state(it1);
    const captures = [{ page: "items", width: 390, theme: "dark", key: `${it1.id}/run_x/items-390-dark.png` }];
    await h.storage.put(captures[0]!.key, PNG);
    await h.finish("screenshot", { status: "succeeded", summary: "", data: { captures, reason: null } });
    await h.controller.tickRuns();
    while (await h.worker.tick()) await h.controller.tickRuns();
    await h.controller.tickRuns();
    expect(h.runner.specs).toHaveLength(1);
    expect(h.runner.specs[0]!.prompt).toContain("`.factory-screenshots/items-390-dark.png`: page items, 390px, dark");
    expect(h.runner.specs[0]!.prompt).toContain("design-system/patterns.md");
    const done = (await h.runs(it1, "review")).find((r) => r.input?.screenshot_review === true)!;
    expect(done.outcome).toMatchObject({ status: "succeeded", data: { screenshot_review: { findings: [{ kind: "code", text: "breaks decision rule 1 on items at 390px, dark" }], unverified: [] } } });
    expect(done.outcome?.status === "succeeded" && done.outcome.data.review).toBeUndefined();
    const [comment, ...more] = await h.comments(it1);
    expect(more).toEqual([]);
    expect(comment).toContain("- breaks decision rule 1 on items at 390px, dark");
    expect(await h.state(it1)).toEqual(before);
  });

  it("lists, per changed page, whether its changed section appeared; a section that did not is listed under unverified", async () => {
    const h = await harness();
    h.runner.script.review = () => ({ output: { verdict: "pass", tier: 2, findings: [], summary: "two pages", changed_pages: [
      { page: "rules", section: "Waiting for you", shown: true },
      { page: "tasks", section: "Needs you, Check group", shown: false },
    ] } });
    const it1 = await h.inReview();
    await h.review(it1, "pass");
    const captures = [{ page: "rules", width: 1280, theme: "light", key: `${it1.id}/run_x/rules-1280-light.png` }];
    await h.storage.put(captures[0]!.key, PNG);
    await h.finish("screenshot", { status: "succeeded", summary: "", data: { captures, reason: null } });
    await h.controller.tickRuns();
    while (await h.worker.tick()) await h.controller.tickRuns();
    await h.controller.tickRuns();
    expect(h.runner.specs[0]!.prompt).toContain("`changed_pages`");
    expect((h.runner.specs[0]!.output_schema as { properties: Record<string, unknown> }).properties.changed_pages).toBeDefined();
    const done = (await h.runs(it1, "review")).find((r) => r.input?.screenshot_review === true)!;
    const stored = done.outcome?.status === "succeeded" ? parseScreenshotReview(done.outcome.data.screenshot_review) : null;
    expect(stored?.pages).toEqual([
      { page: "rules", section: "Waiting for you", shown: true },
      { page: "tasks", section: "Needs you, Check group", shown: false },
    ]);
    expect(stored?.unverified).toContain(sectionNotShownLine({ page: "tasks", section: "Needs you, Check group" }));
    expect(stored?.unverified.some((u) => u.includes("Waiting for you"))).toBe(false);
    const [comment] = await h.comments(it1);
    expect(comment).toMatch(/Changed pages:\n- rules: Waiting for you: shown in the screenshots\n- tasks: Needs you, Check group: not shown in the screenshots/);
    expect(comment).toContain(`- ${sectionNotShownLine({ page: "tasks", section: "Needs you, Check group" })}`);
  });

  it("reads a stored screenshot review with no pages (an older one) as none, and drops a malformed page entry", () => {
    expect(parseScreenshotReview({ findings: [], unverified: [], summary: "" })?.pages).toEqual([]);
    expect(parseScreenshotReview({ findings: [], unverified: [], summary: "", pages: [{ page: " rules ", section: "In effect", shown: true }, { page: "x" }, { page: "", section: "s", shown: false }] })?.pages)
      .toEqual([{ page: "rules", section: "In effect", shown: true }]);
  });

  it("a finished screenshot run and screenshot review add their tokens to the item's token_cost", async () => {
    const h = await harness();
    const it1 = await h.inReview();
    await h.review(it1, "pass");
    const cost = async () => (await h.store.getWorkItem(it1.id))!.token_cost;
    const before = await cost();
    await h.finish("screenshot", { status: "succeeded", summary: "", data: { captures: [], reason: "no chrome", tokens: 7 } });
    await h.controller.tickRuns();
    expect(await cost()).toBe(before + 7);
    await h.finish("review", { status: "succeeded", summary: "", data: { screenshot_review: { findings: [], unverified: [], summary: "" }, tokens: 40 } });
    await h.controller.tickRuns();
    expect(await cost()).toBe(before + 47);
    // Applied once: a second tick adds nothing.
    await h.controller.tickRuns();
    expect(await cost()).toBe(before + 47);
  });

  it("a failed screenshot run still queues the screenshot review, with the failure as its reason", async () => {
    const h = await harness();
    const it1 = await h.inReview();
    await h.review(it1, "pass");
    await h.finish("screenshot", { status: "failed", error_code: "lease_lost", detail: "x", infra: true });
    await h.controller.tickRuns();
    const followUp = (await h.runs(it1, "review")).find((r) => r.input?.screenshot_review === true);
    expect(followUp?.input?.screenshots).toEqual({ captures: [], reason: "the screenshot run failed (lease_lost)" });
    // Not retried: the one screenshot run.
    expect(await h.runs(it1, "screenshot")).toHaveLength(1);
  });
});

describe("the item API", () => {
  async function seeded() {
    const { store, clock } = await newStore();
    const storage = new MemoryStorage();
    const d: UiDeps = { store, scanner: new PatternEgressScanner(async () => []), clock, lease_ms: 60_000, health: new HealthMonitor(async () => [], clock), storage };
    const it1 = await make(store, 1, "A UI change");
    /** One run of `kind`, finished with the outcome `outcome` builds from its id. */
    const finish = async (kind: Run["kind"], key: string, input: NonNullable<NewRun["input"]> | null, outcome: (r: Run) => RunOutcome) => {
      await store.enqueueRun({ work_item_id: it1.id, kind, idempotency_key: key, input });
      const r = (await store.claimRun({ worker_id: "w9" as WorkerId, kinds: [kind], lease_ms: 60_000 }))!;
      await store.completeRun(r.id, r.lease!.token, outcome(r));
      clock.advance(1_000);
      return r;
    };
    /** A screenshot run that stored `items` at 390px in `theme`, with `reason`. */
    const shot = (n: number, theme: "light" | "dark", reason: string | null = null) => finish("screenshot", `s${n}`, null, (r) => ({
      status: "succeeded", summary: "", data: { captures: [{ page: "items", width: 390, theme, key: screenshotKey(it1.id, r.id, "items", 390, theme) }], reason },
    }));
    return { store, storage, d, it1, finish, shot };
  }
  const itemPath = (id: string) => `/api/v1/items/${encodeURIComponent(id)}`;

  it("returns the newest screenshot run's list and the screenshot review's findings, each text through the Withholder", async () => {
    const { d, it1, finish, shot } = await seeded();
    await shot(1, "dark");
    const newest = await shot(2, "light", "the capture of items at 1280px, light failed: boom");
    await finish("review", "r1", { screenshot_review: true, screenshot_run_id: newest.id }, () => ({
      status: "succeeded", summary: "",
      data: { screenshot_review: { findings: [{ kind: "code", text: `breaks decision rule 2 (${SECRET})` }, { kind: "code", text: "breaks decision rule 1 on items at 390px" }], unverified: ["screenshots not captured: boom"], summary: "two rules" } },
    }));
    type Body = { screenshots: { run_id: string; captures: { page: string; width: number; theme: string }[]; reason: string }; screenshot_review: { findings: { kind: string; text: string }[]; unverified: string[] } };
    const body = await json<Body>(d, itemPath(it1.id));
    expect(body.screenshots.run_id).toBe(newest.id);
    expect(body.screenshots.captures.map((c) => `${c.page}-${c.width}-${c.theme}`)).toEqual(["items-390-light"]);
    expect(body.screenshots.reason).toBe("the capture of items at 1280px, light failed: boom");
    expect(body.screenshot_review.findings).toEqual([{ kind: "code", text: expect.stringMatching(/^\[withheld: /) }, { kind: "code", text: "breaks decision rule 1 on items at 390px" }]);
    expect(body.screenshot_review.unverified).toEqual(["screenshots not captured: boom"]);
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it("an item with no screenshot run has screenshots and screenshot_review null", async () => {
    const { d, it1 } = await seeded();
    expect(await json(d, itemPath(it1.id))).toMatchObject({ screenshots: null, screenshot_review: null });
  });

  it("serves an image its run lists, as a PNG data URL, and nothing else", async () => {
    const { storage, d, it1, shot } = await seeded();
    const run = await shot(1, "dark");
    await storage.put(screenshotKey(it1.id, run.id, "items", 390, "dark"), PNG);
    await storage.put(screenshotKey(it1.id, run.id, "items", 390, "light"), PNG);
    const q = (theme: string, runId: string = run.id) => `${SCREENSHOT_PATH}?item=${encodeURIComponent(it1.id)}&run=${runId}&page=items&width=390&theme=${theme}`;
    expect(await json(d, q("dark"))).toEqual({ data_url: `data:image/png;base64,${Buffer.from(PNG).toString("base64")}` });
    // Stored, but not in the run's outcome; or another run: 404.
    expect((await get(d, q("light"))).status).toBe(404);
    expect((await get(d, q("dark", "run_other"))).status).toBe(404);
  });
});

describe("the zero-token alarm", () => {
  it("never counts a screenshot review that had no image (it starts no agent); a review that ran one still counts", () => {
    const now = new Date("2026-11-23T12:00:00.000Z");
    const review = (i: number, input: object | null) => ({
      id: `run_${i}`, work_item_id: `wi_${i}`, kind: "review", status: "succeeded", finished_at: `2026-11-23T11:5${i}:00.000Z`,
      input, outcome: { status: "succeeded", summary: "", data: {} },
    }) as never;
    const noImage = { screenshot_review: true, screenshots: { captures: [], reason: "no Chrome" } };
    const withImage = { screenshot_review: true, screenshots: { captures: [{ page: "items", width: 390, theme: "light", key: "k" }], reason: null } };
    const zero = (input: object | null) => detectAlarms({ runs: [0, 1, 2].map((i) => review(i, input)), restarts: [], now, settings: ALARM_DEFAULTS }).map((f) => f.pattern);
    expect(zero(noImage)).toEqual([]);
    expect(zero(withImage)).toEqual(["zero_tokens"]);
    expect(zero(null)).toEqual(["zero_tokens"]);
  });
});
