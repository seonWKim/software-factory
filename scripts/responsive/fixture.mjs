// The data `npm run check:responsive` looks at: a throwaway SQLite store in a temp dir, seeded with items that
// stress the layout (long titles, long local IDs, long thread bodies, a phase tree, failed runs, alerts, an
// object-valued model_by, many commands, rules on with applied and waiting rules, a standing approval that approved
// three items, three routines: a long name, a paused one, one on the merge trigger), served by the real UI server (dist/ui/server.js) on a free port.
// Nothing here reads factory.config.json, .factory/ or the secrets file: every dependency is built in place.
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncCalendars } from "../../dist/calendar/index.js";
import { ALERT_DEDUPE_MS } from "../../dist/core/alarms.js";
import { SkillRefsStore } from "../../dist/import/import-plugins.js";
import { saveProject } from "../../dist/core/project-labels.js";
import { writeRoutine } from "../../dist/core/routines.js";
import { writeSchedule } from "../../dist/core/schedule.js";
import { SPEC_GATE, STANDING_APPROVED, STANDING_TIER, ruleId, standingActor } from "../../dist/core/standing.js";
import { SystemClock } from "../../dist/impl/clock/system-clock.js";
import { PatternEgressScanner } from "../../dist/impl/egress/pattern-egress-scanner.js";
import { SqlFactoryStore } from "../../dist/impl/store/sql/sql-factory-store.js";
import { SqliteDriver } from "../../dist/impl/store/sqlite/sqlite-driver.js";
import { storeSql } from "../../dist/impl/store/sql/store-sql.js";
import { FsSharedStorage } from "../../dist/impl/storage/fs-shared-storage.js";
import { checkAgentsHome, tacitLedgerAt } from "../../dist/impl/tacit/agents-home-tacit-ledger.js";
import { UiCalendar } from "../../dist/ui/calendar-api.js";
import { HealthMonitor } from "../../dist/ui/health.js";
import { newCsrfToken, storeProjectResolver } from "../../dist/ui/settings-api.js";
import { startUi } from "../../dist/ui/server.js";

const REPO = { owner: "acme-platform-infrastructure", name: "very-long-repository-name-for-layout-checks" };
const PROJECT = { key: "github:github.com:R_kgDOresponsive0000000000001", label: `github.com/${REPO.owner}/${REPO.name}` };
const OWNER = "local:responsive-check-operator-with-a-long-login";
const system = { kind: "system", id: "system:responsive-check" };
const LEASE = 300_000;
const MODEL_BY = {
  triage: "cheap",
  implement: { 1: "standard", 2: "standard", 3: "strong", 4: "strong", 5: "strong" },
  review: "standard",
  resolve: { 1: "standard", 2: "standard", 3: "strong", 4: "strong", 5: "strong" },
  retry_up: true,
};
const LONG_WORD = "configuration_loader_with_an_unbroken_identifier_that_never_has_a_space_in_it";
const LONG_TITLE =
  "Settings page: object-valued keys such as model_by and floors render as readable nested lists on every width, " +
  `including ${LONG_WORD} and a second clause that keeps going well past one line`;
const LONG_BODY = [
  "## Spec",
  "",
  `The page breaks when ${LONG_WORD} appears in a cell. ${"A long paragraph that wraps over many lines. ".repeat(12)}`,
  "",
  "```",
  `npm test -- tests/ui-settings-page.test.tsx --reporter=verbose --some-flag-that-makes-this-line-very-long=${"x".repeat(80)}`,
  "```",
  "",
  `- https://github.com/${REPO.owner}/${REPO.name}/pull/123456789/files#diff-${"0123456789abcdef".repeat(4)}`,
  "- a short point",
].join("\n");

/** A local source with a long ID, as `factory task create` files it. */
const local = (id) => ({ type: "local", id, link: `local:${id}` });

/**
 * Seeds the store and starts the UI on 127.0.0.1 with a free port. Returns its URL, the pages to check and close().
 * `extend({ store, csrfToken, owner })` returns more UI dependencies, which replace the fixture's own (the idle agents'
 * sandbox adds `pauses` and its own `tacit`); the responsive check adds none. The fixture's `tacit` is the Rules page on
 * a seeded agents home in the temp dir (seedRulesHome).
 */
export async function startFixture(extend = () => ({})) {
  const dir = await mkdtemp(join(tmpdir(), "sf-responsive-"));
  const clock = new SystemClock();
  const store = new SqlFactoryStore(new SqliteDriver(join(dir, "factory.sqlite")), clock);
  await store.migrate();
  const storage = new FsSharedStorage(join(dir, "storage"));
  const seeded = await seed(store, storage, dir);

  const csrfToken = newCsrfToken();
  const ui = await startUi(
    {
      store,
      scanner: new PatternEgressScanner(async () => []),
      clock,
      lease_ms: LEASE,
      plugins: { issues: null },
      health: new HealthMonitor(
        async () => [
          { ok: true, msg: "store: sqlite, schema up to date" },
          { ok: false, msg: `check command failed: npm run typecheck exited 2 in ${LONG_WORD}/${LONG_WORD}` },
        ],
        clock,
      ),
      settings: {
        base: {
          file: { workers: 5, heartbeat_ms: 60_000, lease_ms: LEASE, max_loops: 3, model_by: MODEL_BY },
          layers: {
            defaults: { max_attempts: 3, floors: [{ prefix: "src/impl/runner/", tier: 4 }, { prefix: "prompts/", tier: 3 }] },
            projects: { [`${REPO.owner}/${REPO.name}`]: { max_diff_files: 10 } },
          },
          max_workers: 10,
        },
        repo: REPO,
        actor: OWNER,
        resolveProject: storeProjectResolver(store, REPO),
        csrfToken,
        calendar: await seedCalendar(store, clock),
      },
      storage,
      commands: { actor: OWNER, source: "config", token: csrfToken, allowed: async () => ({ allow: true }), localMerge: true },
      tacit: rulesOn(seedRulesHome(join(dir, "agents"))),
      ...(await extend({ store, csrfToken, owner: OWNER })),
    },
    0,
  );
  return {
    url: `http://127.0.0.1:${ui.port}`,
    pages: seeded,
    async close() {
      await ui.close();
      await store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function make(store, id, title, extra = {}) {
  return (await store.createWorkItem({ source: local(id), title, requester_id: OWNER, project: PROJECT.key, problem: LONG_BODY, resources: [], ...extra }, system)).item;
}

async function patch(store, item, p, reason = "responsive_fixture") {
  const cur = await store.getWorkItem(item.id);
  const r = await store.transition({ id: item.id, expected_version: cur.version, patch: p, actor: system, reason });
  if (!r.ok) throw new Error(`fixture transition ${reason} failed: ${r.reason}`);
}

/** Enqueues one run of `kind` for `item`, claims it and finishes it with `outcome` (null: leaves it running). */
async function runOnce(store, item, kind, key, outcome, worker = "host-with-a-long-name.example.internal:4242:3") {
  const cur = await store.getWorkItem(item.id);
  await store.transition({ id: item.id, expected_version: cur.version, patch: {}, actor: system, reason: `enqueue_${kind}`, enqueue: { kind, idempotency_key: key } });
  const run = await store.claimRun({ worker_id: worker, kinds: [kind], lease_ms: LEASE });
  if (run === null) throw new Error(`fixture could not claim the ${kind} run ${key}`);
  if (outcome) await store.completeRun(run.id, run.lease.token, outcome);
  return run;
}

/** The fixture's rows; returns the app paths to check that need an ID (an item, a parent, a transcript). */
async function seed(store, storage, dir) {
  await saveProject(store, REPO, PROJECT);

  // The item with everything: a long title and ID, failed runs with a transcript, a long thread, commands.
  // Its done_checks: one line per result kind the item page's Done when list draws; the results are in the newest implement run below.
  const doneChecks = [
    { line: `Passing: ${LONG_TITLE}`, command: "npm run typecheck" },
    { line: `Failing: ${LONG_TITLE}`, command: "npm test" },
    { line: `Manual: ${LONG_TITLE}`, manual: true, reason: `a person looks at the page in a narrow window ${LONG_WORD}` },
    { line: `Not run: ${LONG_TITLE}`, test_file: `tests/${LONG_WORD}.test.ts` },
  ];
  const busy = await make(store, `local-${"a1b2c3d4".repeat(6)}-settings-object-values`, LONG_TITLE, { done_checks: doneChecks });
  const failure = {
    status: "failed",
    error_code: "checks_failed",
    detail: `npm test exited 1: FAIL tests/${LONG_WORD}.test.ts > expected 4310 to be 4311`,
    infra: false,
    output_tail: `${"stack frame at src/core/very/deep/module/path/file.ts:123:45\n".repeat(8)}`,
  };
  await runOnce(store, busy, "triage", "busy:t", { status: "succeeded", summary: "spec written", data: { tokens: 123_456 } });
  const failed = await runOnce(store, busy, "implement", "busy:i1", failure);
  // The newest implement run's outcome carries each done-when line's result; the failing line shows this long tail.
  const doneResults = [
    { line: doneChecks[0].line, result: "pass", check: doneChecks[0].command },
    { line: doneChecks[1].line, result: "fail", check: doneChecks[1].command },
    { line: doneChecks[2].line, result: "manual", check: doneChecks[2].reason },
    { line: doneChecks[3].line, result: "not_run", check: `npm test -- tests/${LONG_WORD}.test.ts` },
  ];
  const longTail = Array.from({ length: 40 }, (_, n) => `FAIL tests/${LONG_WORD}.test.ts > case ${n + 1}: expected 4310 to be 4311 at src/core/very/deep/module/path/file.ts:${n + 100}:45`).join("\n");
  await runOnce(store, busy, "implement", "busy:i2", { ...failure, error_code: "agent_error", infra: true, output_tail: longTail, done_checks: doneResults });
  await storage.put(`transcripts/${busy.id}/${failed.id}.json`, readFileSync(new URL("../../tests/fixtures/transcripts/failed-run.jsonl", import.meta.url)));
  await patch(store, busy, { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", change_ref: "123456", tier: 3, token_cost: 987_654 });
  for (let i = 1; i <= 6; i++) {
    await store.recordItemMessage({ work_item_id: busy.id, marker: `local:${i}`, actor: OWNER, body: i % 2 ? LONG_BODY : `/approve ${LONG_WORD} note ${i}` });
  }
  for (let i = 1; i <= 12; i++) {
    await store.appendCliCommand({ key: `responsive-${i}`, actor: OWNER, command: i % 3 ? "approve" : "resolve", args: { work_item_id: busy.id, note: `${LONG_WORD} ${i}` } });
    await store.recordAppCommandRequest({ key: `responsive-app-${i}`, actor: OWNER, command: "approve", args: { work_item_id: busy.id, note: `note ${i} ${LONG_WORD}` } });
  }

  // A Merge that came back (merge_returned) with a long refusal naming the item's ID: the Needs you row keeps its title
  // and shows the refusal on its own line below it, wrapped, with no raw ID (the 2026-11-22 screenshot).
  const back = await make(store, `local-${"b4c7ba".repeat(6)}-merge-returned`, `Returned: ${LONG_TITLE}`);
  await patch(store, back, { stage: "REVIEW", blocked_on: "ci", blocked_reason: "merge_queued", change_ref: "123457", tier: 2 });
  const cur = await store.getWorkItem(back.id);
  const refusal = `${back.id} could not merge: the head moved since the review passed (${"Supercalifragilistic".repeat(4)})`;
  const r = await store.transition({ id: back.id, expected_version: cur.version, patch: { blocked_on: "human", blocked_reason: "merge_pending" }, actor: system, reason: "merge_returned", detail: { refusal } });
  if (!r.ok) throw new Error(`fixture transition merge_returned failed: ${r.reason}`);
  // Mergeable, so its Merge is on and the row reads why the last one came back.
  await store.recordMergeCheck({ work_item_id: back.id, mergeable: true, conflicts: [], head_sha: "a".repeat(40), base_sha: "b".repeat(40) });

  // A phase tree: a parent with three phases, one waiting on the one before it.
  const parent = await make(store, `local-${"f00dfeed".repeat(5)}-split-parent`, `Split: ${LONG_TITLE}`);
  for (let p = 1; p <= 3; p++) {
    await make(store, `local-${"f00dfeed".repeat(5)}-phase-${p}`, `Phase ${p}/3: ${LONG_TITLE.slice(0, 40 * p)}`, {
      parent: { id: parent.id, phase: p },
      ...(p > 1 ? { hold: { blocked_on: "upstream", blocked_reason: "phase_hold" } } : {}),
    });
  }

  // Many more items in every stage, so the lists, Floor, Queue and Workers fill up.
  const stages = [
    { stage: "READY", blocked_on: "human", blocked_reason: "spec_pending" },
    { stage: "NEW", blocked_on: "none" },
    { stage: "CLOSED", close_reason: "failed" },
    { stage: "CLOSED", close_reason: "completed" },
  ];
  for (let n = 1; n <= 16; n++) {
    const it = await make(store, `local-${String(n).padStart(4, "0")}-${"9e8d7c6b".repeat(4)}`, n % 2 ? LONG_TITLE : `Short ${n}`);
    await patch(store, it, stages[n % stages.length]);
  }
  for (let n = 1; n <= 3; n++) {
    const it = await make(store, `local-running-${n}-${"cafe".repeat(8)}`, `Running ${n}: ${LONG_TITLE}`);
    await patch(store, it, { stage: "RUNNING" });
    await runOnce(store, it, "implement", `run:${n}`, null, `host-${n}-${"b".repeat(30)}:1:${n}`);
  }

  // Host sleeps (Health's Runs tab): one that held the failed run, on two workers, and an idle one.
  const woke = (min) => new Date(Date.now() - min * 60_000).toISOString();
  for (const slot of [0, 1]) await store.recordHostSleep({ worker_id: `host-with-a-long-name.example.internal:4242:${slot}`, woke_at: woke(90), gap_ms: 15 * 60_000, run_id: slot === 0 ? failed.id : null });
  await store.recordHostSleep({ worker_id: "host-with-a-long-name.example.internal:4242:0", woke_at: woke(600), gap_ms: 8 * 60_000, run_id: null });
  // PRs merged with no work item (Tasks' Worth sampling, Health's Review tab): one with a long title, one recorded before titles were kept.
  await store.recordUnreviewedMerge({ project: PROJECT.key, change_ref: "436", merge_sha: "c".repeat(40), merger_id: OWNER, title: `Seed golden cases: ${LONG_TITLE}` });
  await store.recordUnreviewedMerge({ project: PROJECT.key, change_ref: "162", merge_sha: "d".repeat(40), merger_id: OWNER });

  // One open plain task with a due date, so the Tasks rows (and their small-target check) have a task to draw. Its
  // title is long but holds no snake_case name (raw-name).
  await store.addTask({ id: "tk_responsive_plain_task", title: "Pay rent and file the quarterly receipts for the apartment before the landlord's office closes on Friday", list: "inbox", priority: 1, due: { days_from_today: 1 }, due_time: null, recurrence: null, created_by: OWNER });

  // Alerts and a claim pause, for the Floor and Health banners.
  await store.recordAlert({ pattern: "repeated_error", pattern_key: "repeated_error:responsive", error_code: "checks_failed", count: 7, detail: `npm test exited 1 in ${LONG_WORD}` }, ALERT_DEDUPE_MS);
  await store.recordAlert({ pattern: "zero_tokens", pattern_key: "zero_tokens:responsive", error_code: "agent_error", count: 3, detail: null }, ALERT_DEDUPE_MS);
  await store.pauseClaims(new Date(Date.now() + 3_600_000).toISOString(), "model_stall");

  await seedStanding(store);
  await seedSkill(store, dir);
  await seedRoutines(store);
  await seedSchedules(store);

  // Overrides: an object-valued model_by and a project-level key, with history.
  await store.setSettingOverride({ key: "model_by", project: "", value: JSON.stringify({ ...MODEL_BY, review: "strong" }), actor: OWNER });
  await store.setSettingOverride({ key: "max_diff_files", project: PROJECT.key, value: "40", actor: OWNER });

  return { item: busy.id, parent: parent.id, run: failed.id };
}

/**
 * One imported skill with an eval suite: the Plugins page's Skills tab shows a row whose Evals button is on (a row needs its
 * SKILL.md path, which only an imported skill has), so the screenshot run can open the Evals dialog (design 04-screenshots).
 * The skill's ref is its skills folder joined with its name, as the page keys a suite.
 */
async function seedSkill(store, dir) {
  const name = "fixture-review";
  const folder = join(dir, "skills");
  const path = join(folder, name, "SKILL.md");
  mkdirSync(join(folder, name), { recursive: true });
  const text = `---\ndescription: Reviews a change against the repository's rules and names each broken one.\n---\n\n# ${name}\n`;
  writeFileSync(path, text);
  const sha256 = createHash("sha256").update(text).digest("hex");
  await new SkillRefsStore(storeSql(store), () => new Date().toISOString()).insert({ source: "claude", kind: "skill", name, path, sha256 }, OWNER);
  await store.createSkillEvalSuite({ id: "suite_responsive_fixture", skill_ref: `${folder}/${name}`, title: "Fixture suite", created_by: OWNER });
}

/**
 * Three routines, so the Routines page draws its table, row menus and paused Notice (and the screenshot run its New
 * routine Dialog over them): one with a long name on a weekly schedule, one paused on an interval, one on the merge
 * trigger. Plain text: no token-like string. Added through the same core write the API runs.
 */
async function seedRoutines(store) {
  const now = new Date();
  const routines = [
    { id: "rtn_responsive_long", name: "Weekly review of every documentation page that mentions the dashboard, the settings or the routines and their caps", instruction: `Read each page and list the sentences that no longer match the product. ${"Name the page and the section for each one. ".repeat(4)}`, url: "https://example.com/docs/dashboard/overview", schedule: { kind: "weekly", spec: "mon,fri 09:00" }, zone: "Europe/Paris", run_cap_usd: 2, daily_cap_usd: 5 },
    { id: "rtn_responsive_paused", name: "Stale pages check", instruction: "List the pages that have not changed in ninety days.", schedule: { kind: "interval", spec: "240" }, run_cap_usd: 1 },
    { id: "rtn_responsive_merge", name: "After each merge", instruction: "Read the merged change and suggest one follow-up, if any.", trigger: "merge" },
  ];
  for (const { id, ...fields } of routines) {
    const r = await writeRoutine(store, "add", id, fields, OWNER, now);
    if (!r.ok) throw new Error(`fixture routine ${id} failed: ${r.problem}`);
  }
  const paused = await writeRoutine(store, "pause", "rtn_responsive_paused", {}, OWNER, now);
  if (!paused.ok) throw new Error(`fixture routine pause failed: ${paused.problem}`);
}

/**
 * Two plain schedules, so the Schedules page draws its table, Switches and row menus: a daily build, and a weekly agent
 * that is paused. Added through the same core write the API runs.
 */
async function seedSchedules(store) {
  const now = new Date();
  const schedules = [
    { id: "sch_responsive_docs", title: "Nightly docs check", cadence: "daily", spec: "09:00", zone: "Europe/Paris", action: "build", body: "Check the docs for pages that no longer match the product." },
    { id: "sch_responsive_review", title: "Weekly review", cadence: "weekly", spec: "mon 09:00", zone: "Europe/Paris", action: "agent", body: "Summarize the week's merged changes." },
  ];
  for (const { id, ...fields } of schedules) {
    const r = await writeSchedule(store, "add", id, fields, OWNER, now);
    if (!r.ok) throw new Error(`fixture schedule ${id} failed: ${r.problem}`);
  }
  const paused = await writeSchedule(store, "pause", "sch_responsive_review", {}, OWNER, now);
  if (!paused.ok) throw new Error(`fixture schedule pause failed: ${paused.problem}`);
}

/** How many items the standing approval approved in the last 7 days: more than the two its Rules page row names before "+N more". */
const STANDING_ITEMS = 3;

/** One standing approval (`spec-t1`) that is on, and the items it approved in the last 7 days, as the controller records them. */
async function seedStanding(store) {
  const rule = await store.putStandingRule({ gate: SPEC_GATE, tier: STANDING_TIER, enabled: true, set_by: OWNER });
  for (let n = 1; n <= STANDING_ITEMS; n++) {
    const it = await make(store, `local-standing-${n}-${"5ade".repeat(6)}`, `Approved by the standing rule ${n}: ${LONG_TITLE.slice(0, 60)}`);
    await patch(store, it, { stage: "READY", blocked_on: "human", blocked_reason: "spec_pending", tier: STANDING_TIER });
    const cur = await store.getWorkItem(it.id);
    const detail = { standing_rule: ruleId(rule.gate, rule.tier), gate: rule.gate, tier: rule.tier, kind: "spec", owner_id: rule.set_by };
    const r = await store.transition({ id: it.id, expected_version: cur.version, patch: { blocked_on: "none", blocked_reason: null }, actor: standingActor(rule.gate, rule.tier), reason: STANDING_APPROVED, detail });
    if (!r.ok) throw new Error(`fixture transition ${STANDING_APPROVED} failed: ${r.reason}`);
  }
}

/** The Rules page's waiting entries, as `evolve pending` prints them: one class and one proposal, each with a long title. */
const PENDING_TEXT = [
  "## proposals (open) 1",
  `- P-0042 [edit-asset] prompts/review.md — Ask the reviewer to name the page and width of each broken rule in ${LONG_WORD}`,
  "## proposals (held) 0",
  "## tacit Pending 1",
  "- C-101 open every summary with the answer before any detail, even in a long thread",
  "## tacit Held 0",
  "",
].join("\n");

/** The Rules page's applied rules (In effect): two promoted rules and one encoded elsewhere. */
const RULES_TEXT = [
  "# Rules",
  "",
  "## C-090 keep existing CLI flags",
  "- 기본값: Keep every existing CLI flag working; add a new flag instead of changing what an old one means.",
  "- 예외: a flag the owner asked to remove.",
  "- 범위: scripts/ and src/cli/",
  "- 근거: 인시던트 T-1, T-2 / 판정일 2026-11-13",
  "",
  `## C-091 one value per row in ${LONG_WORD}`,
  "- 기본값: Show one value per row; put the rest behind a disclosure.",
  "- 근거: 인시던트 T-3 / 판정일 2026-11-20",
  "",
  "## 다른 곳에 인코딩된 규칙",
  "- C-009 → CLAUDE.md",
  "",
].join("\n");

/**
 * A throwaway agents home under `dir` for the Rules page, as scripts/idle-agents/sandbox.mjs wires a real one: the
 * rules file (applied rules) and stub `bin/tacit`, `bin/evolve` and `bin/sync-agents` that print fixed text for the
 * forms the page reads (`evolve pending`, `evolve show <id>`, `tacit show --active --unclustered`) and change nothing.
 * Node scripts, so they run wherever this fixture's node does.
 */
function seedRulesHome(dir) {
  mkdirSync(join(dir, "bin"), { recursive: true });
  mkdirSync(join(dir, "private", "tacit"), { recursive: true });
  writeFileSync(join(dir, "private", "tacit", "rules.md"), RULES_TEXT);
  const show = {
    "C-101": ["### C-101 summary first", "- 인시던트: T-4, T-5", "- 초안: 기본값: Open every summary with the answer. / 예외: 없음", "- 범위: software", "", "# incidents", "# verdicts", ""].join("\n"),
    "P-0042": ["# P-0042 page and width", "target: prompts/review.md", "current: Name the rule.", "proposed: Name the rule, the page and the width.", ""].join("\n"),
  };
  const outputs = {
    tacit: { "show --active --unclustered": "# active, unclustered\n" },
    evolve: { pending: PENDING_TEXT, ...Object.fromEntries(Object.entries(show).map(([id, text]) => [`show ${id}`, text])) },
    "sync-agents": {},
  };
  for (const [cli, out] of Object.entries(outputs)) {
    const file = join(dir, "bin", cli);
    writeFileSync(file, `#!${process.execPath}\nconst out = ${JSON.stringify(out)}[process.argv.slice(2).join(" ")];\nif (out !== undefined) process.stdout.write(out);\n`);
    chmodSync(file, 0o755);
  }
  return dir;
}

/** The UI's Rules dependency with the `agents-home` ledger on at `home` (AGENTS_HOME for its CLIs only; this process's env is left alone). */
function rulesOn(home) {
  const env = { AGENTS_HOME: home };
  return {
    ledger: tacitLedgerAt(env),
    settings: { refresh: async () => {}, values: () => ({ integrations: { tacit: "agents-home" } }) },
    home: () => checkAgentsHome(env),
  };
}

/**
 * The Settings page's Calendar section, as compose.ts wires it for the UI: two plugins with long names, one connected
 * whose last sync failed with a long error, one never connected. Its connect flow is never run by the check.
 */
async function seedCalendar(store, clock) {
  const connected = `calendar-plugin-${LONG_WORD}`;
  const failing = { events: async () => { throw new Error(`token refresh failed: invalid_grant for ${LONG_WORD} ${"while reading the calendar list ".repeat(4)}`); } };
  await syncCalendars(storeSql(store), [{ name: connected, source: failing }], clock.now().getTime());
  return new UiCalendar({
    plugins: [
      { name: connected, secrets: ["CALENDAR_CLIENT_ID", "CALENDAR_CLIENT_SECRET"] },
      { name: "second-calendar", secrets: ["SECOND_CALENDAR_TOKEN"] },
    ],
    listed: async () => [connected],
    run: async () => {
      throw new Error("the responsive check never connects a calendar");
    },
  });
}
