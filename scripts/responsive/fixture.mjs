// The data `npm run check:responsive` looks at: a throwaway SQLite store in a temp dir, seeded with items that
// stress the layout (long titles, long local IDs, long thread bodies, a phase tree, failed runs, alerts, an
// object-valued model_by, many commands), served by the real UI server (dist/ui/server.js) on a free port.
// Nothing here reads factory.config.json, .factory/ or the secrets file: every dependency is built in place.
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALERT_DEDUPE_MS } from "../../dist/core/alarms.js";
import { saveProject } from "../../dist/core/project-labels.js";
import { SystemClock } from "../../dist/impl/clock/system-clock.js";
import { PatternEgressScanner } from "../../dist/impl/egress/pattern-egress-scanner.js";
import { SqlFactoryStore } from "../../dist/impl/store/sql/sql-factory-store.js";
import { SqliteDriver } from "../../dist/impl/store/sqlite/sqlite-driver.js";
import { FsSharedStorage } from "../../dist/impl/storage/fs-shared-storage.js";
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

/** A local source with a long ID, as `factory issue` files it. */
const local = (id) => ({ type: "local", id, link: `local:${id}` });

/** Seeds the store and starts the UI on 127.0.0.1 with a free port. Returns its URL, the pages to check and close(). */
export async function startFixture() {
  const dir = await mkdtemp(join(tmpdir(), "sf-responsive-"));
  const clock = new SystemClock();
  const store = new SqlFactoryStore(new SqliteDriver(join(dir, "factory.sqlite")), clock);
  await store.migrate();
  const storage = new FsSharedStorage(join(dir, "storage"));
  const seeded = await seed(store, storage);

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
      },
      storage,
      commands: { actor: OWNER, source: "config", token: csrfToken, mergeAllowed: async () => true, localMerge: true },
      users: {
        identity: { user: OWNER, from: "config" },
        permissions: { grants: ["static"], static: { roles: { [OWNER]: { "*": ["approver"] }, "github:69591622": { [PROJECT.key]: ["approver", "requester"] } } } },
        csrfToken,
        log: { info() {}, warn() {}, error() {} },
      },
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
async function seed(store, storage) {
  await saveProject(store, REPO, PROJECT);

  // The item with everything: a long title and ID, failed runs with a transcript, a long thread, commands.
  const busy = await make(store, `local-${"a1b2c3d4".repeat(6)}-settings-object-values`, LONG_TITLE);
  const failure = {
    status: "failed",
    error_code: "checks_failed",
    detail: `npm test exited 1: FAIL tests/${LONG_WORD}.test.ts > expected 4310 to be 4311`,
    infra: false,
    output_tail: `${"stack frame at src/core/very/deep/module/path/file.ts:123:45\n".repeat(8)}`,
  };
  await runOnce(store, busy, "triage", "busy:t", { status: "succeeded", summary: "spec written", data: { tokens: 123_456 } });
  const failed = await runOnce(store, busy, "implement", "busy:i1", failure);
  await runOnce(store, busy, "implement", "busy:i2", { ...failure, error_code: "agent_error", infra: true });
  await storage.put(`transcripts/${busy.id}/${failed.id}.json`, readFileSync(new URL("../../tests/fixtures/transcripts/failed-run.jsonl", import.meta.url)));
  await patch(store, busy, { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", change_ref: "123456", tier: 3, token_cost: 987_654 });
  for (let i = 1; i <= 6; i++) {
    await store.recordItemMessage({ work_item_id: busy.id, marker: `local:${i}`, actor: OWNER, body: i % 2 ? LONG_BODY : `/approve ${LONG_WORD} note ${i}` });
  }
  for (let i = 1; i <= 12; i++) {
    await store.appendCliCommand({ key: `responsive-${i}`, actor: OWNER, command: i % 3 ? "approve" : "resolve", args: { work_item_id: busy.id, note: `${LONG_WORD} ${i}` } });
    await store.recordAppCommandRequest({ key: `responsive-app-${i}`, actor: OWNER, command: "approve", args: { work_item_id: busy.id, note: `note ${i} ${LONG_WORD}` } });
  }

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

  // Alerts and a claim pause, for the Floor and Health banners.
  await store.recordAlert({ pattern: "repeated_error", pattern_key: "repeated_error:responsive", error_code: "checks_failed", count: 7, detail: `npm test exited 1 in ${LONG_WORD}` }, ALERT_DEDUPE_MS);
  await store.recordAlert({ pattern: "zero_tokens", pattern_key: "zero_tokens:responsive", error_code: "agent_error", count: 3, detail: null }, ALERT_DEDUPE_MS);
  await store.pauseClaims(new Date(Date.now() + 3_600_000).toISOString(), "model_stall");

  // Overrides: an object-valued model_by and a project-level key, with history.
  await store.setSettingOverride({ key: "model_by", project: "", value: JSON.stringify({ ...MODEL_BY, review: "strong" }), actor: OWNER });
  await store.setSettingOverride({ key: "max_diff_files", project: PROJECT.key, value: "40", actor: OWNER });

  return { item: busy.id, parent: parent.id, run: failed.id };
}
