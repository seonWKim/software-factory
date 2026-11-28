import { describe, expect, it } from "vitest";
import { MIGRATIONS } from "../src/impl/store/sqlite/schema.js";
import { ARCHIVE_ONLY, RENAMES } from "../src/state/migrations/20261108T1300-state-prefix-tables.migration.js";
import { newStore, issue, system, PROJECT_KEY } from "./helpers/store.js";

describe.each([{ name: "sqlite", make: newStore }])("FactoryStore contract: $name", ({ name, make: makeBackend }) => {
  const make = makeBackend;
  describe("inbound_cursors", () => {
    it("advances only from the expected value", async () => {
      const { store } = await make();
      expect(await store.advanceCursor("intake", null, "a")).toBe(true);
      expect(await store.advanceCursor("intake", null, "b")).toBe(false);
      expect(await store.advanceCursor("intake", "a", "b")).toBe(true);
      expect(await store.advanceCursor("intake", "a", "c")).toBe(false);
      expect(await store.getCursor("intake")).toBe("b");
    });
  });

  describe("raw table reads (design §9 Data page)", () => {
        // Every table the baseline creates, under its RFC 0015 name, plus its legacy copy (kept until the contract step).
    const BASELINE_TABLES = [...new Set(MIGRATIONS.flatMap((m) => [...m.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)/g)].map((x) => x[1]!)))];
    const renamed = new Map(RENAMES.map((r) => [r.from, r.to]));
    // RFC 0015 M4 (D7): inbound_app_requests merged into inbound_commands; both old tables are kept as legacy_*.
    const merged = ["inbound_app_requests"];
    // Issue #577: the local users and their audit are dropped; the owner moved to identity_owner (src/identity/migrations/20261113T1500-identity-owner).
    const dropped = ["identity_local_users", "identity_local_user_changes"];
    const DOMAIN_TABLES = [
      ...BASELINE_TABLES.map((t) => renamed.get(t) ?? t).filter((t) => !(ARCHIVE_ONLY as readonly string[]).includes(t) && !merged.includes(t) && !dropped.includes(t)),
      "legacy_inbound_app_requests",
      "legacy_inbound_commands",
      // Rebuilt without pr_number (src/controller/migrations/20261112T1200-controller-change-ref-only); kept until its contract step.
      "legacy_controller_unreviewed_merges",
      "legacy_controller_work_items",
      // Rebuilt with a nullable cadence and trigger_kind (src/controller/migrations/20261125T1000-controller-schedules-trigger); kept until its contract step.
      "legacy_controller_schedules",
      // Rebuilt with a replay number per replay (src/controller/migrations/20261124T1300-controller-skill-eval-replay-index); kept until its contract step.
      "legacy_controller_skill_eval_replays",
      // Rebuilt for the plugin import's pointers (src/state/migrations/20261116T1300 and 20261116T1310); kept until the contract step.
      "legacy_ext_packs_entries",
      "legacy_ext_skill_refs",
      ...BASELINE_TABLES.filter((t) => renamed.has(t) || (ARCHIVE_ONLY as readonly string[]).includes(t)).map((t) => `legacy_${t}`),
      "runtime_schema_migrations",
      // Tables of timestamped component migrations (RFC 0015 §6.3).
      "authz_audit",
      "identity_passports",
      "identity_owner", // the one owner (issue #577): src/identity/migrations/20261113T1500-identity-owner
      "identity_profiles", // display names by user id (owner decision 2026-11-08)
      "identity_revocations",
      "worker_run_steps", // RFC 0015 M6: src/worker/migrations/20261108T1730-worker-run-journal
      "controller_merge_queues", // RFC 0015 M8: src/controller/migrations/20261109T0300-controller-merge-queue
      "controller_merge_queue_entries",
      "controller_signals", // the signal ledger: src/controller/migrations/20261111T1210-controller-signals
      "controller_skill_eval_suites", // skill evals: the *-controller-skill-evals migration
      "controller_skill_eval_cases",
      "controller_skill_eval_runs",
      "controller_skill_eval_replays",
      "controller_skill_eval_labels", // the owner's labels on the judge (design 06-measurement): the *-controller-skill-eval-labels migration
      "controller_skill_drafts", // skill improvement: the *-controller-skill-improve migration
      "controller_skill_draft_days",
      "controller_skill_version_gates", // new skill versions' gates (design 07-self-improvement): the *-controller-skill-eval-gate migration
      "controller_tasks", // plain tasks: src/controller/migrations/20261111T1610-controller-tasks
      "controller_notices", // owner notices: src/controller/migrations/20261112T0900-controller-notices
      "controller_notice_messages", "controller_notice_questions", // Slack notice records: 20261112T2100-controller-notice-messages
      "controller_projects", "controller_task_projects", // task projects: 20261113T1300-controller-task-projects
      "controller_pause_history", // ended model-stall and network pauses (design 07-self-improvement): 20261118T1200-controller-pause-history
      "controller_design_learnings", // owner corrections to UI changes (design 07-design-learnings): 20261120T1201-controller-design-learnings
      "controller_schedules", "controller_schedule_runs", // schedules (design 08-schedules): 20261122T1000-controller-schedules
      "controller_standing_rule_changes", // one record per standing-rule change (design 05-standing-approvals): 20261122T1300-state-standing-rule-changes
      "controller_green_bases", // the last green base per project (design 03-risk, red-main revert): 20261123T1001-controller-green-base
      "controller_attachments", // images and links on a New item (design 02-attachments): 20261120T1000-controller-attachments
      "controller_routines", "controller_routine_suggestions", // routines (src/core/check-page.ts): 20261120T1001-controller-routines
      "controller_schedule_suggestions", // routine suggestions copied to schedules (design 08-schedules): 20261124T1100-controller-routines-into-schedules
      "controller_activity", // one row per autonomous action (design 08-schedules-actions): 20261126T1201-state-controller-activity
      "controller_chat_messages", // chat messages and tool calls (docs/plugins/llm-provider.md): src/state/migrations/20261126T1200-state-chat-sessions
      "controller_coordinator_actions", "controller_coordinator_due", // the coordinator (design 05-coordinator): the *-controller-coordinator-actions migration
      "controller_chat_spend", // chat turn spend (design 04-chat-agent): src/state/migrations/20261126T1300-state-chat-spend
      "controller_chat_turns", // chat turn outcomes (design 04-chat-agent): src/state/migrations/20261126T1400-state-chat-turns
      "controller_held_writes", // agent writes the permission gate held (design 08-permissions): src/state/migrations/20261127T1100-state-held-writes
      "worker_test_slots", // host test slots (one per full test run in progress): src/state/migrations/20261128T1000-state-test-slots
      "ext_packs_approvals", // approvals of pack entries: src/state/migrations/20261111T1600-state-ext-packs-approvals
      "ext_packs_entries", // pack tool and MCP server entries: src/state/migrations/20261111T1201-state-ext-packs-entries
      "ext_skill_refs", // imported skill references (design 11-plugin-import): src/state/migrations/20261115T1200-state-ext-skill-refs
      "ext_mcp_tool_lists", // tool listings of imported MCP servers (design 11-plugin-import): src/state/migrations/20261116T1200-state-ext-mcp-tool-lists
      "ext_skill_versions", // imported skills' versions (design 11-plugin-import): src/state/migrations/20261124T1001-state-ext-skill-versions
      "runtime_config_file_changes", // file-only key edits (design 08-settings): src/state/migrations/20261113T1200-state-config-file-changes
      "calendar_events", // the calendar component: src/calendar/migrations/20261112T1700-calendar-events
      "calendar_sync_state",
      "calendar_sync_requests", "calendar_synced_ranges", // on-demand sync: src/calendar/migrations/20261121T1001-calendar-sync-requests
      "calendar_local_events", // the owner's own events: src/calendar/migrations/20261124T1003-calendar-local-events
      "calendar_write_access", // whether each connected calendar takes writes: src/calendar/migrations/20261125T0900-calendar-local-provider
      // The sql bus's own tables (RFC 0015 M3).
      "bus_scheduler",
      "bus_topics",
      // Outbox and inbox of the components on the bus (RFC 0015 M4).
      "controller_inbox",
      "controller_outbox",
      "inbound_inbox",
      "inbound_outbox",
      "inbound_sequence_locks", // src/inbound/migrations/20261109T1015-inbound-sequence-locks
      // Outbound's delivery tables (RFC 0015 M7).
      "outbound_actions",
      "outbound_batch_intents",
      "outbound_batches",
      "outbound_inbox",
      "outbound_outbox",
      "outbound_requests",
      "runtime_hook_decisions",
      "runtime_learned_settings", // learned settings (issue #497): src/runtime/migrations/20261111T1400-runtime-learned-settings
      "runtime_learned_setting_changes",
    ];

    it("lists every table of the schema with its row count, columns, primary key and order", async () => {
      const { store, clock } = await make();
      const a = (await store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "t:1" } })).item;
      clock.advance(1000);
      await store.createWorkItem(issue(2), system);
      await store.recordConflicts({ project: PROJECT_KEY, paths: ["src/a.ts", "src/b.ts"], event_key: "e1" });
      const tables = await store.listTables();
      const names = tables.map((t) => t.name);
      expect(names).toEqual([...names].sort());
      for (const t of DOMAIN_TABLES) expect(names, t).toContain(t);
      // The item thread and the command inbox (migration 24, issue #281).
      if (name === "sqlite") expect(names).toEqual([...DOMAIN_TABLES, "schema_migrations"].sort());
      else expect(names).toContain("schema_migrations");
      const byName = new Map(tables.map((t) => [t.name, t]));
      expect(byName.get("controller_work_items")).toMatchObject({ rows: 2, primary_key: ["id"], order_by: ["created_at", "id"] });
      expect(byName.get("controller_work_items")!.columns).toEqual(expect.arrayContaining(["id", "title", "created_at", "updated_at"]));
      expect(byName.get("worker_runs")).toMatchObject({ rows: 1 });
      expect(byName.get("controller_state_changes")).toMatchObject({ rows: 2, order_by: ["at", "id"] });
      expect(byName.get("controller_file_conflicts")).toMatchObject({ rows: 2, primary_key: ["project_key", "path", "event_key"], order_by: ["at", "project_key", "path", "event_key"] });
      expect(byName.get("worker_run_attempts")).toMatchObject({ rows: 0, primary_key: ["run_id", "attempt"], order_by: ["started_at", "run_id", "attempt"] });
      expect(byName.get("inbound_cursors")).toMatchObject({ primary_key: ["name"], order_by: ["name"] });
      expect(byName.get("controller_claim_decisions")).toMatchObject({ rows: 0 });
      expect(a.id).toMatch(/^wi_/);
    });

    it("a page is newest first by the order column, honours limit and offset, and returns the total", async () => {
      const { store, clock } = await make();
      const ids: string[] = [];
      for (let n = 1; n <= 7; n++) {
        ids.push((await store.createWorkItem(issue(n), system)).item.id);
        clock.advance(1000);
      }
      const newest = [...ids].reverse();
      const p1 = (await store.listTableRows({ table: "controller_work_items", limit: 3 }))!;
      expect(p1).toMatchObject({ total: 7, limit: 3, offset: 0 });
      expect(p1.rows.map((r) => r.id)).toEqual(newest.slice(0, 3));
      const p3 = (await store.listTableRows({ table: "controller_work_items", limit: 3, offset: 6 }))!;
      expect(p3.rows.map((r) => r.id)).toEqual(newest.slice(6));
      expect(p3.total).toBe(7);
      // Without a time column the primary key orders, descending.
      for (const c of ["b", "c", "a"]) await store.advanceCursor(c, null, "v");
      expect((await store.listTableRows({ table: "inbound_cursors" }))!.rows.map((r) => r.name)).toEqual(["c", "b", "a"]);
      // Every column comes back, numbers as numbers.
      expect(p1.rows[0]).toMatchObject({ version: 1, title: null });
    });

    it("no limit gives 50 rows; a limit above 200 is capped at 200", async () => {
      const { store } = await make();
      // 205 one-row transactions, sent together.
      const created = await Promise.all(
        Array.from({ length: 205 }, (_, n) => store.advanceCursor(`c${String(n).padStart(3, "0")}`, null, "v")),
      );
      expect(created.every(Boolean)).toBe(true);
      const def = (await store.listTableRows({ table: "inbound_cursors" }))!;
      expect(def.rows).toHaveLength(50);
      expect(def).toMatchObject({ limit: 50, total: 205 });
      const big = (await store.listTableRows({ table: "inbound_cursors", limit: 1000 }))!;
      expect(big.rows).toHaveLength(200);
      expect(big.limit).toBe(200);
    }, 30_000);

    it("an exact-value filter returns only equal rows; a quote in the value is bound, not spliced", async () => {
      const { store } = await make();
      const quoted = `it's "quoted"; --`;
      const q = (await store.createWorkItem({ ...issue(1), problem: quoted }, system)).item;
      await store.createWorkItem(issue(2), system);
      await store.createWorkItem({ ...issue(3), problem: "problem 2" }, system);
      const hit = (await store.listTableRows({ table: "controller_work_items", filter: { column: "problem", value: quoted } }))!;
      expect(hit.total).toBe(1);
      expect(hit.rows.map((r) => r.id)).toEqual([q.id]);
      const two = (await store.listTableRows({ table: "controller_work_items", filter: { column: "problem", value: "problem 2" } }))!;
      expect(two.total).toBe(2);
      expect(two.rows.every((r) => r.problem === "problem 2")).toBe(true);
      const inject = (await store.listTableRows({ table: "controller_work_items", filter: { column: "problem", value: "x' OR '1'='1" } }))!;
      expect(inject).toMatchObject({ total: 0, rows: [] });
      // A number column matches its text form.
      expect((await store.listTableRows({ table: "controller_work_items", filter: { column: "version", value: "1" } }))!.total).toBe(3);
    });

    it("an unknown table or filter column is refused with null", async () => {
      const { store } = await make();
      expect(await store.listTableRows({ table: "nope" })).toBeNull();
      expect(await store.listTableRows({ table: "work_items; DROP TABLE worker_runs" })).toBeNull();
      expect(await store.listTableRows({ table: "controller_work_items", filter: { column: "id = id OR 1", value: "x" } })).toBeNull();
      expect((await store.listTables()).map((t) => t.name)).toContain("worker_runs");
    });
  });
});
