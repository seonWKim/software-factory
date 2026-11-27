// The data `npm run check:responsive` looks at: a throwaway SQLite store in a temp dir, seeded with items that
// stress the layout (long titles, long local IDs, long thread bodies, a phase tree, failed runs, alerts, an
// object-valued model_by, many commands, rules on with applied and waiting rules, a standing approval that approved
// three items), served by the real UI server (dist/ui/server.js) on a free port.
// Nothing here reads factory.config.json, .factory/ or the secrets file: every dependency is built in place.
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestCalendarSync, runSyncRequests, syncCalendars } from "../../dist/calendar/index.js";
import { ALERT_DEDUPE_MS } from "../../dist/core/alarms.js";
import { SkillRefsStore, skillRefId } from "../../dist/import/import-plugins.js";
import { skillVersion } from "../../dist/runtime/capabilities/capabilities.js";
import { saveProject } from "../../dist/core/project-labels.js";
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
  const skill = await seedSkill(store, dir);
  await seedSchedules(store);

  // Overrides: an object-valued model_by and a project-level key, with history.
  await store.setSettingOverride({ key: "model_by", project: "", value: JSON.stringify({ ...MODEL_BY, review: "strong" }), actor: OWNER });
  await store.setSettingOverride({ key: "max_diff_files", project: PROJECT.key, value: "40", actor: OWNER });

  return { item: busy.id, parent: parent.id, run: failed.id, skill };
}

const SKILL_NAME = "fixture-review";
const SKILL_SUITE = "suite_responsive_fixture";
/** The fixture skill's SKILL.md, oldest first: each is written over the one before and recorded as the next version. */
const SKILL_TEXTS = [
  `---\ndescription: Reviews a change against the repository's rules and names each broken one.\n---\n\n# ${SKILL_NAME}\n`,
  `---\ndescription: Reviews a change against the repository's rules, names each broken one and the page and width it breaks at.\n---\n\n# ${SKILL_NAME}\n\nName the rule, the page and the width of each finding.\n`,
];
/** Per version: each of the two cases' verdicts (the run's pass rate is their pass share). */
const SKILL_VERDICTS = [["pass", "fail"], ["pass", "pass"]];

/**
 * One imported skill with an eval suite of two cases and two versions, so the Plugins page's Skills tab has a row whose
 * Evals button is on (a row needs its SKILL.md path, which only an imported skill has) and the Evals page (evals/<skill>)
 * draws two version rows, the newer one current, and a Compare dialog with a diff and a case table. Each SKILL.md text
 * in turn is written, its folder hash taken (skillVersion, as eval runs store it), recorded (recordSkillVersion), and
 * one finished run bound to that hash gets a replay per case and its figures. Returns the suite's skill_ref: the skills
 * folder joined with the name, as the pages key a suite. Exported for tests/responsive-fixture-evals.test.ts.
 */
export async function seedSkill(store, dir) {
  const folder = join(dir, "skills");
  const skillFolder = join(folder, SKILL_NAME);
  const path = join(skillFolder, "SKILL.md");
  const skill_ref = `${folder}/${SKILL_NAME}`;
  mkdirSync(skillFolder, { recursive: true });
  const refs = new SkillRefsStore(storeSql(store), () => new Date().toISOString());
  await store.createSkillEvalSuite({ id: SKILL_SUITE, skill_ref, title: "Fixture suite", created_by: OWNER });
  const cases = [];
  for (const n of [1, 2]) cases.push(await store.addSkillEvalCase({ id: `case_responsive_${n}`, suite_id: SKILL_SUITE, input: { change: `Change ${n}` }, expected: { rule: `Rule ${n}` } }));

  for (const [i, text] of SKILL_TEXTS.entries()) {
    writeFileSync(path, text);
    const found = { source: "claude", kind: "skill", name: SKILL_NAME, path, sha256: createHash("sha256").update(text).digest("hex") };
    await refs.insert(found, OWNER);
    const folder_hash = await skillVersion(skillFolder);
    if (!(await store.recordSkillVersion({ ref_id: skillRefId(found), folder_hash, text, source: "claude" }))) throw new Error(`fixture skill version ${i + 1} was not recorded`);
    const verdicts = SKILL_VERDICTS[i];
    const run = await store.startSkillEvalRun({ id: `run_responsive_${i + 1}`, suite_id: SKILL_SUITE, created_by: OWNER, skill_version: folder_hash });
    for (const [c, verdict] of verdicts.entries()) await store.recordSkillEvalReplay({ run_id: run.id, case_id: cases[c].id, verdict, detail: {} });
    await store.finishSkillEvalRun(run.id, verdicts.includes("fail") ? "failed" : "passed");
    const passed = verdicts.filter((v) => v === "pass").length;
    await store.recordSkillEvalRunFigures(run.id, { model_class: "standard", judge_model_class: "strong", replays: verdicts.length, pass_rate: passed / verdicts.length, errored: 0 });
  }
  return skill_ref;
}

/**
 * Two plain schedules, so the Schedules page draws its table, Switches and row menus: a daily build, and a weekly agent
 * that is paused. Beside them three Check a page samples: a long name on a weekly cadence, one paused on an interval, and
 * one On each merge. Added through the same core write the API runs.
 */
async function seedSchedules(store) {
  const now = new Date();
  const schedules = [
    { id: "sch_responsive_docs", title: "Nightly docs check", cadence: "daily", spec: "09:00", zone: "Europe/Paris", action: "build", body: "Check the docs for pages that no longer match the product." },
    { id: "sch_responsive_review", title: "Weekly review", cadence: "weekly", spec: "mon 09:00", zone: "Europe/Paris", action: "agent", body: "Summarize the week's merged changes." },
    {
      id: "sch_responsive_page_long", title: "Weekly check of the public pricing page for broken links, stale prices and out-of-date plan names", cadence: "weekly", spec: "mon,thu 09:00", zone: "Europe/Paris",
      action: "check-page", url: "https://example.com/pricing", instruction: "Look for broken links, prices that differ from the product and plan names that no longer exist.", run_cap_usd: 0.5, daily_cap_usd: 2,
    },
    { id: "sch_responsive_page_paused", title: "Status page check", cadence: "interval", spec: "240", zone: "Europe/Paris", action: "check-page", url: "https://example.com/status", instruction: "Report any incident shown as open." },
    { id: "sch_responsive_page_merge", title: "Docs check on each merge", cadence: "on-merge", action: "check-page", url: "https://example.com/docs", instruction: "Find pages that no longer match the merged change.", daily_cap_usd: 1 },
  ];
  for (const { id, ...fields } of schedules) {
    const r = await writeSchedule(store, "add", id, fields, OWNER, now);
    if (!r.ok) throw new Error(`fixture schedule ${id} failed: ${r.problem}`);
  }
  const paused = await writeSchedule(store, "pause", "sch_responsive_review", {}, OWNER, now);
  if (!paused.ok) throw new Error(`fixture schedule pause failed: ${paused.problem}`);
  const pagePaused = await writeSchedule(store, "pause", "sch_responsive_page_paused", {}, OWNER, now);
  if (!pagePaused.ok) throw new Error(`fixture schedule pause failed: ${pagePaused.problem}`);
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

/**
 * The Rules page's waiting entries, as `evolve pending` prints them: a class waiting and one held, and three proposals
 * (one of each kind, two with Korean titles, as the owner's ledger has them), each with a long title.
 */
const PENDING_TEXT = [
  "## proposals (open) 3",
  `- P-0042 [edit-asset] prompts/review.md — Ask the reviewer to name the page and width of each broken rule in ${LONG_WORD}`,
  "- P-0043 [promote-learning] agent-skills/review/SKILL.md — 리뷰 결과는 깨진 규칙마다 페이지와 화면 폭을 함께 적는다",
  "- P-0044 [new-asset] agent-skills/ui-check/learnings.md — 화면 점검 스킬의 learnings 파일을 새로 만든다",
  "## proposals (held) 0",
  "## tacit Pending 1",
  "- C-101 open every summary with the answer before any detail, even in a long thread",
  "## tacit Held 1",
  "- C-102 ask before widening a request beyond the named section",
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
    "P-0043": ["# P-0043 리뷰 결과에 폭", "target: agent-skills/review/SKILL.md", "current: - 깨진 규칙을 적는다.", "proposed: - 깨진 규칙마다 페이지와 화면 폭을 함께 적는다.", ""].join("\n"),
    "P-0044": ["# P-0044 learnings 파일", "target: agent-skills/ui-check/learnings.md", "proposed: # ui-check learnings", ""].join("\n"),
    "C-102": ["### C-102 narrow scope", "- 인시던트: T-6, T-7", "- 초안: 기본값: Ask before widening a request. / 예외: 없음", "- 범위: 전역", "", "# incidents", "# verdicts", ""].join("\n"),
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
 * whose last sync failed with a long error, one never connected. Its connect flow is never run by the check. Before
 * that failure the connected one synced the events of calendarEvents for this week and month (a scheduled sync and an
 * on-demand one), so the Calendar page draws them with the stale notice, and its first event chip opens the detail
 * popover (capture.mjs `open: "calendar-event"`).
 */
async function seedCalendar(store, clock) {
  const connected = `calendar-plugin-${LONG_WORD}`;
  const db = storeSql(store);
  const now = clock.now();
  const before = now.getTime() - 6 * 60_000;
  const list = calendarEvents(now);
  const ok = { events: async (w) => list.filter((e) => e.starts_at < w.to && e.ends_at > w.from) };
  await syncCalendars(db, [{ name: connected, source: ok }], before);
  const day = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  // The Month view's whole weeks (they hold this week): the Monday before the month's first day to the Sunday after its last.
  const mondayOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
  const first = mondayOf(new Date(now.getFullYear(), now.getMonth(), 1));
  const end = mondayOf(new Date(now.getFullYear(), now.getMonth() + 1, 0));
  const last = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 6);
  await requestCalendarSync(db, { from: day(first), to: day(last), by: OWNER, nowMs: before });
  await runSyncRequests(db, [{ name: connected, source: ok }], before);
  const failing = { events: async () => { throw new Error(`token refresh failed: invalid_grant for ${LONG_WORD} ${"while reading the calendar list ".repeat(4)}`); } };
  await syncCalendars(db, [{ name: connected, source: failing }], now.getTime());
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

/**
 * This week's events: first (Monday 09:00) one with a long title, a place, notes written as HTML with a link, a video
 * link, an organizer and attendees; then an all-day event and short ones, five on today (its Month cell shows "+N more").
 */
function calendarEvents(now) {
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
  const at = (dayOffset, h, m = 0) => new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + dayOffset, h, m).toISOString();
  const today = (now.getDay() + 6) % 7;
  const person = (name, email, response) => ({ name, email, response });
  return [
    {
      id: "interview", title: `Your interview with ${REPO.owner}: final round with the hiring committee, system design and a long tail of ${LONG_WORD}`,
      starts_at: at(0, 9), ends_at: at(0, 10, 30), all_day: false, updated_at: null,
      details: {
        calendar: "Work and interviews", location: "Building 4, Room 1201 (Tall Ships), 1 Harbour Street, Seoul",
        description: `<b>Agenda</b><br>1. Intro<br>2. System design &amp; trade-offs<br>Prep notes: <a href="https://example.com/prep/${LONG_WORD}">prep doc</a><script>alert(1)</script>`,
        organizer: person("Hiring Coordinator", "coordinator@example.com", "accepted"),
        attendees: [
          person("Hiring Coordinator", "coordinator@example.com", "accepted"), person("Alex Kim", "owner@example.com", "accepted"),
          person(null, `panel-${LONG_WORD}@example.com`, "waiting"), person("Staff Engineer", "staff@example.com", "tentative"),
        ],
        conference_url: "https://meet.example.com/abc-defg-hij", link: "https://calendar.google.com/calendar/event?eid=responsive", time_zone: "America/Los_Angeles",
      },
    },
    { id: "offsite", title: "Team offsite", starts_at: at(2, 0), ends_at: at(3, 0), all_day: true, updated_at: null },
    { id: "one-on-one", title: "Alex Kim <> Mentor", starts_at: at(today, 11, 30), ends_at: at(today, 12), all_day: false, updated_at: null },
    { id: "review", title: "Design review", starts_at: at(today, 17), ends_at: at(today, 18), all_day: false, updated_at: null },
    // Three more on today, so its Month cell overflows into "+N more" (owner #92: a short meeting with a mixed-script title).
    { id: "short-meeting", title: "15 min meeting between Yeongjun Kim and 김선우", starts_at: at(today, 9, 15), ends_at: at(today, 9, 30), all_day: false, updated_at: null,
      details: { calendar: "Work and interviews", location: null, description: null, organizer: null, attendees: [], conference_url: null, link: "https://calendar.google.com/calendar/event?eid=short", time_zone: null } },
    { id: "lunch", title: "Lunch", starts_at: at(today, 12, 30), ends_at: at(today, 13, 30), all_day: false, updated_at: null },
    { id: "focus", title: "Focus time", starts_at: at(today, 14), ends_at: at(today, 16), all_day: false, updated_at: null },
  ];
}
