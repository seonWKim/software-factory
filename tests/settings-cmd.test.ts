import { describe, expect, it } from "vitest";
import { retryConfig, stallConfig } from "../src/compose.js";
import { coordinationConfig } from "../src/core/config.js";
import { saveProjectLabel } from "../src/core/project-labels.js";
import { SETTABLE_KEYS, type SettingsBase, intakeLabel } from "../src/core/settings.js";
import type { Timestamp, WorkItemId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { type SettingsDeps, parseModeArgs, parseSettingsArgs, runSettings } from "../src/settings-cmd.js";
import { HealthMonitor } from "../src/ui/health.js";
import { SETTINGS_PATH, type UiSettings, newCsrfToken, writeSettings } from "../src/ui/settings-api.js";
import { type UiDeps, type UiRequest, respond } from "../src/ui/server.js";
import type { ConfigEditRequest, ConfigEditResult } from "../src/core/config-writer.js";
import { PROJECT } from "./helpers/fakes.js";
import { BACKENDS, PROJECT_KEY, newStore } from "./helpers/store.js";

/** The file: workers 5, heartbeat 60 s, lease 300 s, max_attempts 3, and o/r's block with max_diff_files 10. */
const base: SettingsBase = {
  file: { workers: 5, heartbeat_ms: 60_000, lease_ms: 300_000, max_loops: 3 },
  layers: { defaults: { max_attempts: 3 }, projects: { "o/r": { max_diff_files: 10 } } },
};

function deps(store: FactoryStore, actor = "local:owner"): SettingsDeps & { resolved: number } {
  const d = {
    store,
    base,
    repo: { owner: "o", name: "r" },
    resolved: 0,
    resolveProject: async () => {
      d.resolved++;
      return PROJECT;
    },
    actor,
  };
  return d;
}

async function run(d: SettingsDeps, ...args: string[]) {
  const a = parseSettingsArgs(args);
  if ("error" in a) throw new Error(a.error);
  return runSettings(d, a);
}

describe("settings arguments", () => {
  it("list, set, reset, history; anything else is an error", () => {
    expect(parseSettingsArgs(["list"])).toEqual({ action: "list" });
    expect(parseSettingsArgs(["set", "workers", "2"])).toEqual({ action: "set", key: "workers", value: "2" });
    expect(parseSettingsArgs(["set", "max_attempts", "2", "--project", "o/r"])).toEqual({ action: "set", key: "max_attempts", value: "2", project: "o/r" });
    expect(parseSettingsArgs(["reset", "workers"])).toEqual({ action: "reset", key: "workers" });
    expect(parseSettingsArgs(["history"])).toEqual({ action: "history", limit: 50 });
    expect(parseSettingsArgs(["history", "--limit", "5"])).toEqual({ action: "history", limit: 5 });
    for (const bad of [[], ["nope"], ["set", "workers"], ["reset"], ["history", "--limit", "0"], ["list", "x"], ["set", "a", "b", "--project"]]) {
      expect(parseSettingsArgs(bad)).toEqual({ error: expect.any(String) });
    }
  });
});

describe.each(BACKENDS)("factory settings: $name", ({ make }) => {
  it("set writes the override and exactly one audit row with key, project, old, new, actor and time", async () => {
    const { store, clock } = await make();
    const d = deps(store);
    const r = await run(d, "set", "workers", "2");
    expect(r).toEqual({ ok: true, lines: ["workers = 2 (override; was 5, file)", "applies at the worker pool's next tick, with no restart"] });
    expect(await store.listSettingOverrides()).toEqual([expect.objectContaining({ key: "workers", project: "", value: "2", set_by: "local:owner" })]);
    expect(await store.listSettingChanges(10)).toEqual([
      { seq: expect.any(Number), key: "workers", project: "", old_value: null, new_value: "2", actor: "local:owner", at: clock.now().toISOString() },
    ]);
    // A set to the current value still writes a row.
    await run(d, "set", "workers", "2");
    expect(await store.listSettingChanges(10)).toHaveLength(2);
    expect(d.resolved).toBe(0);
  });

  it("workers above the config file's max_workers (absent: its workers) is refused with the reason; nothing is written", async () => {
    const { store } = await make();
    const r = await run(deps(store), "set", "workers", "6");
    expect(r.ok).toBe(false);
    expect(r.lines[0]).toContain("workers 6 is above the config file's max_workers (5)");
    expect(await store.listSettingOverrides()).toEqual([]);
    expect(await store.listSettingChanges(10)).toEqual([]);
  });

  it("workers above the file's workers but within max_workers is stored: the pool raises it live", async () => {
    const { store } = await make();
    const d = { ...deps(store), base: { ...base, max_workers: 8 } };
    const r = await run(d, "set", "workers", "8");
    expect(r.ok).toBe(true);
    expect(await store.listSettingOverrides()).toMatchObject([{ key: "workers", value: "8" }]);
    const refused = await run(d, "set", "workers", "9");
    expect(refused.lines[0]).toContain("workers 9 is above the config file's max_workers (8)");
  });

  it("heartbeat × 2 ≥ lease is refused, using the other key's effective value", async () => {
    const { store } = await make();
    const d = deps(store);
    expect(await run(d, "set", "lease_ms", "120000")).toEqual({ ok: false, lines: ["refused: heartbeat_ms must be well under lease_ms"] });
    expect(await run(d, "set", "heartbeat_ms", "150000")).toEqual({ ok: false, lines: ["refused: heartbeat_ms must be well under lease_ms"] });
    expect((await run(d, "set", "heartbeat_ms", "30000")).ok).toBe(true);
    // Now the heartbeat override is the other key's effective value.
    expect((await run(d, "set", "lease_ms", "90000")).ok).toBe(true);
    expect(await run(d, "set", "heartbeat_ms", "50000")).toEqual({ ok: false, lines: ["refused: heartbeat_ms must be well under lease_ms"] });
    // Resetting heartbeat back to the file's 60 s would leave 120 s ≥ the 90 s lease.
    expect(await run(d, "reset", "heartbeat_ms")).toEqual({ ok: false, lines: ["refused: heartbeat_ms must be well under lease_ms"] });
    expect(await store.listSettingChanges(10)).toHaveLength(2);
  });

  it("PR-only keys and keys outside the settable list are refused; nothing is written", async () => {
    const { store } = await make();
    const d = deps(store);
    for (const k of ["plugins", "repo", "store", "floors", "dials", "secrets", "egress", "broker"]) {
      const r = await run(d, "set", k, "{}");
      expect(r.ok).toBe(false);
      expect(r.lines[0]).toContain(`"${k}" changes by PR only`);
      expect((await run(d, "reset", k)).lines[0]).toContain("changes by PR only");
    }
    for (const k of ["budgets", "inbox_retention_days", "stats", "ui", "branch_prefix", "max_loop", "auth", "permissions"]) {
      const r = await run(d, "set", k, "1");
      expect(r.ok).toBe(false);
      expect(r.lines[0]).toContain(`"${k}" is not settable`);
    }
    expect(await store.listSettingOverrides()).toEqual([]);
    expect(await store.listSettingChanges(10)).toEqual([]);
  });

  it("an invalid value is refused with the config loader's message for that key", async () => {
    const { store } = await make();
    const d = deps(store);
    const cases: [string, string, string][] = [
      ["workers", "0", "workers must be an integer of 1 or more (got 0)"],
      ["max_attempts", "x", "max_attempts must be a positive integer"],
      ["max_diff_lines", "1.5", "max_diff_lines must be a positive integer"],
      ["retry_base_ms", "-1", "retry_base_ms must be a positive integer"],
      ["models", '{"cheap":"haiku"}', "models.standard must be a model name (non-empty string)"],
      ["model_by", '{"triage":"huge"}', 'model_by: triage is "huge"; must be one of cheap, standard, strong'],
      ["retry_base_ms", "9999999", "retry_base_ms must not exceed retry_max_ms"],
    ];
    for (const [k, v, msg] of cases) expect(await run(d, "set", k, v), k).toEqual({ ok: false, lines: [`refused: ${msg}`] });
    expect(await store.listSettingChanges(10)).toEqual([]);
  });

  it("first_output_ms takes a positive integer and is refused with the config loader's message otherwise", async () => {
    const { store } = await make();
    const d = deps(store);
    for (const bad of [0, -1, 1.5]) {
      let loader = "";
      try {
        stallConfig({ first_output_ms: bad });
      } catch (err) {
        loader = (err as Error).message;
      }
      expect(loader).toBe("first_output_ms must be a positive integer");
      expect(await run(d, "set", "first_output_ms", String(bad))).toEqual({ ok: false, lines: [`refused: ${loader}`] });
    }
    expect(await store.listSettingChanges(10)).toEqual([]);
    expect(await run(d, "set", "first_output_ms", "60000")).toEqual({
      ok: true,
      lines: ["first_output_ms = 60000 (override; was 180000, default)", "applies at the next run that starts, with no restart"],
    });
  });

  it("--project: only for the three gate keys, only with the configured repo's ID, and only to tighten", async () => {
    const { store } = await make();
    const d = deps(store);
    expect((await run(d, "set", "tick_ms", "100", "--project", "o/r")).lines[0]).toContain("--project applies only to max_attempts, max_diff_lines, max_diff_files");
    expect((await run(d, "set", "max_attempts", "2", "--project", "x/y")).lines[0]).toContain('project "x/y" does not match the configured repo\'s ID "o/r"');
    expect(await run(d, "set", "max_attempts", "4", "--project", "o/r")).toEqual({
      ok: false,
      lines: ['refused: projects["github.com/o/r"].max_attempts is 4, above the global value 3; a project may only tighten a gate'],
    });
    expect(await store.listSettingChanges(10)).toEqual([]);

    expect((await run(d, "set", "max_attempts", "2", "--project", "o/r")).lines[0]).toBe("max_attempts for github.com/o/r = 2 (override; was 3, file)");
    expect(await store.listSettingOverrides()).toEqual([expect.objectContaining({ key: "max_attempts", project: PROJECT_KEY, value: "2" })]);
    // The project override above the project's file block.
    expect((await run(d, "set", "max_diff_files", "5", "--project", "o/r")).lines[0]).toBe("max_diff_files for github.com/o/r = 5 (override; was 10, file)");
  });

  it("a global set that leaves a project's file value looser than it is refused, naming the project", async () => {
    const { store } = await make();
    const r = await run(deps(store), "set", "max_diff_files", "8");
    expect(r).toEqual({
      ok: false,
      lines: ['refused: max_diff_files 8 would leave projects["o/r"].max_diff_files (10) looser than the global value; a project may only tighten a gate'],
    });
    expect((await run(deps(store), "set", "max_diff_files", "12")).ok).toBe(true);
  });

  it("a global set that would leave a project override looser is refused too", async () => {
    const { store } = await make();
    await saveProjectLabel(store, PROJECT);
    const d = deps(store);
    expect((await run(d, "set", "max_attempts", "2", "--project", "o/r")).ok).toBe(true);
    expect((await run(d, "set", "max_attempts", "1")).lines[0]).toBe(
      'refused: projects["github.com/o/r"].max_attempts is 2, above the global value 1; a project may only tighten a gate',
    );
  });

  it("reset writes one audit row; reset with no override is refused and writes none", async () => {
    const { store } = await make();
    const d = deps(store, "local:other");
    expect(await run(d, "reset", "workers")).toEqual({ ok: false, lines: ["refused: workers has no override; nothing to reset"] });
    expect(await store.listSettingChanges(10)).toEqual([]);
    await run(d, "set", "workers", "3");
    expect(await run(d, "reset", "workers")).toEqual({ ok: true, lines: ["workers = 5 (file; was 3, override)", "applies at the worker pool's next tick, with no restart"] });
    expect((await store.listSettingChanges(10))[0]).toMatchObject({ key: "workers", project: "", old_value: "3", new_value: null, actor: "local:other" });
    expect(await store.listSettingChanges(10)).toHaveLength(2);
    // A project override needs --project to be reset.
    await run(d, "set", "max_attempts", "2", "--project", "o/r");
    expect((await run(d, "reset", "max_attempts")).lines[0]).toBe("refused: max_attempts has no override; nothing to reset");
    expect((await run(d, "reset", "max_attempts", "--project", "o/r")).ok).toBe(true);
    expect(await store.listSettingOverrides()).toEqual([]);
  });

  it("list shows every settable key with its effective value and source; history is newest first", async () => {
    const { store, clock } = await make();
    await saveProjectLabel(store, PROJECT);
    const d = deps(store);
    await run(d, "set", "tick_ms", "500");
    clock.advance(1000);
    await run(d, "set", "max_attempts", "2", "--project", "o/r");
    const list = (await run(d, "list")).lines;
    const n = SETTABLE_KEYS.length;
    expect(list).toHaveLength(n + 3);
    const line = (k: string) => list.find((l) => l.trimStart().startsWith(`${k} `))!.split(/\s+/).filter(Boolean);
    expect(line("tick_ms")).toEqual(["tick_ms", "override", "500"]);
    expect(line("workers")).toEqual(["workers", "file", "5"]);
    expect(line("phases_auto_approve")).toEqual(["phases_auto_approve", "default", "false"]);
    expect(line("max_attempts")).toEqual(["max_attempts", "file", "3"]);
    expect(line("run_timeout_ms")).toEqual(["run_timeout_ms", "default", "2700000"]);
    expect(line("first_output_ms")).toEqual(["first_output_ms", "default", "180000"]);
    expect(list.slice(n)).toEqual([
      "project github.com/o/r:",
      expect.stringMatching(/^ {2}max_attempts\s+override\s+2$/),
      expect.stringMatching(/^ {2}max_diff_files\s+file\s+10$/),
    ]);
    const hist = (await run(d, "history")).lines;
    expect(hist).toEqual([
      `${clock.now().toISOString()}  local:owner  max_attempts for github.com/o/r  (no override) → 2`,
      `${new Date(clock.now().getTime() - 1000).toISOString()}  local:owner  tick_ms  (no override) → 500`,
    ]);
    expect((await run(d, "history", "--limit", "1")).lines).toHaveLength(1);
  });
});

// Built here so no secret-shaped literal sits in the repository.
const STYLE_SECRET = `ghp_${"Ab3".repeat(12)}`;
const styleScanner = new PatternEgressScanner(async () => []);

describe.each(BACKENDS)("factory settings set message_style: $name", ({ make }) => {
  const styled = (store: FactoryStore) => ({ ...deps(store), scanner: styleScanner });

  it("a JSON string of at most 1000 characters is stored with the actor and the time in history", async () => {
    const { store, clock } = await make();
    const style = "Short sentences. Lead with the decision.";
    const r = await run(styled(store), "set", "message_style", JSON.stringify(style));
    expect(r).toEqual({ ok: true, lines: [`message_style = ${JSON.stringify(style)} (override; was "", default)`, "applies at the next model call, with no restart"] });
    expect(await store.listSettingChanges(10)).toEqual([
      { seq: expect.any(Number), key: "message_style", project: "", old_value: null, new_value: JSON.stringify(style), actor: "local:owner", at: clock.now().toISOString() },
    ]);
    // Exactly 1000 characters is allowed.
    expect((await run(styled(store), "set", "message_style", JSON.stringify("x".repeat(1000)))).ok).toBe(true);
  });

  it("over 1000 characters is refused with the reason; nothing is stored", async () => {
    const { store } = await make();
    const r = await run(styled(store), "set", "message_style", JSON.stringify("x".repeat(1001)));
    expect(r).toEqual({ ok: false, lines: ["refused: message_style is 1001 characters; at most 1000 are allowed"] });
    expect(await store.listSettingOverrides()).toEqual([]);
    expect(await store.listSettingChanges(10)).toEqual([]);
  });

  it("a value the egress scanner flags is refused naming the rule, never the text; nothing is stored", async () => {
    const { store } = await make();
    const r = await run(styled(store), "set", "message_style", JSON.stringify(`Sign off with ${STYLE_SECRET}`));
    expect(r.ok).toBe(false);
    expect(r.lines[0]).toMatch(/^refused: message_style was flagged by the egress scanner \(.+\)/);
    expect(r.lines.join("\n")).not.toContain(STYLE_SECRET);
    expect(await store.listSettingOverrides()).toEqual([]);
    expect(await store.listSettingChanges(10)).toEqual([]);
  });

  it("with no scanner wired, a set is refused rather than stored unscanned; other keys are unaffected", async () => {
    const { store } = await make();
    const r = await run(deps(store), "set", "message_style", JSON.stringify("Plain words."));
    expect(r.ok).toBe(false);
    expect(r.lines[0]).toContain("egress scanner");
    expect(await store.listSettingOverrides()).toEqual([]);
    expect((await run(deps(store), "set", "max_loops", "4")).ok).toBe(true);
  });

  it("a value that is not a string is refused", async () => {
    const { store } = await make();
    const r = await run(styled(store), "set", "message_style", "42");
    expect(r).toEqual({ ok: false, lines: ["refused: message_style must be a JSON string (the text of the style)"] });
    expect(await store.listSettingOverrides()).toEqual([]);
  });
});

describe("factory mode", () => {
  it("is settings set mode, with --project; anything else is an error", () => {
    expect(parseModeArgs(["auto"])).toEqual({ action: "set", key: "mode", value: '"auto"' });
    expect(parseModeArgs(["manual", "--project", "o/r"])).toEqual({ action: "set", key: "mode", value: '"manual"', project: "o/r" });
    for (const bad of [[], ["on"], ["auto", "x"], ["auto", "--limit", "2"], ["auto", "--project"]]) {
      expect(parseModeArgs(bad)).toEqual({ error: expect.any(String) });
    }
  });
});

describe.each(BACKENDS)("factory mode and auto_merge_max_tier: $name", ({ make }) => {
  it("a flip writes one audit row with the actor and the time; the default is manual", async () => {
    const { store, clock } = await make();
    const d = deps(store);
    expect((await run(d, "list")).lines.find((l) => l.startsWith("mode "))).toContain('default   "manual"');
    const a = parseModeArgs(["auto"]);
    if ("error" in a) throw new Error(a.error);
    expect(await runSettings(d, a)).toMatchObject({ ok: true, lines: ['mode = "auto" (override; was "manual", default)', expect.any(String)] });
    expect(await store.listSettingChanges(10)).toEqual([
      { seq: expect.any(Number), key: "mode", project: "", old_value: null, new_value: '"auto"', actor: "local:owner", at: clock.now().toISOString() },
    ]);
  });

  it("takes a project mode, and refuses a value other than auto or manual", async () => {
    const { store } = await make();
    await saveProjectLabel(store, PROJECT);
    const d = deps(store);
    expect((await run(d, "set", "mode", "auto", "--project", "o/r")).ok).toBe(true);
    expect(await store.listSettingOverrides()).toEqual([expect.objectContaining({ key: "mode", project: PROJECT_KEY, value: '"auto"' })]);
    const bad = await run(d, "set", "mode", "on");
    expect(bad).toEqual({ ok: false, lines: ['refused: mode must be "manual" or "auto"'] });
  });

  it("auto_merge_max_tier takes 0 to 3 and refuses anything higher", async () => {
    const { store } = await make();
    const d = deps(store);
    expect((await run(d, "set", "auto_merge_max_tier", "3")).ok).toBe(true);
    for (const v of ["4", "-1", "1.5", '"2"']) {
      const r = await run(d, "set", "auto_merge_max_tier", v);
      expect(r.ok, v).toBe(false);
      expect(r.lines[0], v).toContain("from 0 to 3");
    }
    expect(await store.listSettingChanges(10)).toHaveLength(1);
  });

  it("a set or reset of mode or auto_merge_max_tier without approve_merge is refused and writes no row; other keys are not asked", async () => {
    const { store } = await make();
    let asked = 0;
    const d: SettingsDeps = { ...deps(store, "local:dev"), mayApproveMerge: async () => (asked++, "the requester role cannot approve_merge") };
    for (const args of [["set", "mode", "auto"], ["set", "auto_merge_max_tier", "2"], ["reset", "mode"]]) {
      const r = await run(d, ...args);
      expect(r.ok).toBe(false);
      expect(r.lines[0]).toContain("only with approve_merge on the project: the requester role cannot approve_merge");
    }
    expect(asked).toBe(3);
    expect(await store.listSettingChanges(10)).toEqual([]);
    expect((await run(d, "set", "workers", "2")).ok).toBe(true);
    expect(asked).toBe(3);
  });

  it("a refusal names the owner check's reason and no grant to add (One owner)", async () => {
    const { store } = await make();
    const d: SettingsDeps = { ...deps(store, "github:1"), mayApproveMerge: async () => "not_owner" };
    const r = await run(d, "set", "mode", "auto");
    expect(r.lines[0]).toBe("refused: mode changes only with approve_merge on the project: not_owner");
  });

  it("a set or reset that loosens a tighten-only key needs approve_merge; tightening does not", async () => {
    const { store } = await make();
    let refusal: string | null = "the requester role cannot approve_merge";
    let asked = 0;
    const d: SettingsDeps = { ...deps(store, "local:dev"), mayApproveMerge: async () => (asked++, refusal) };
    // Tightening: max_loops 3 (file) → 2, phases_auto_approve stays false. Not asked.
    expect((await run(d, "set", "max_loops", "2")).ok).toBe(true);
    expect((await run(d, "set", "phases_auto_approve", "false")).ok).toBe(true);
    expect(asked).toBe(0);
    // Loosening without the grant: refused, nothing written.
    for (const args of [["set", "max_loops", "5"], ["reset", "max_loops"], ["set", "phases_auto_approve", "true"], ["set", "max_attempts", "4"]]) {
      const r = await run(d, ...args);
      expect(r.ok).toBe(false);
      expect(r.lines[0]).toMatch(/^refused: loosening \S+ from .* needs approve_merge on the project: the requester role cannot approve_merge$/);
    }
    expect(asked).toBe(4);
    expect(await store.listSettingChanges(10)).toHaveLength(2);
    // With the grant: allowed.
    refusal = null;
    expect((await run(d, "set", "phases_auto_approve", "true")).ok).toBe(true);
    expect((await run(d, "reset", "max_loops")).ok).toBe(true);
    expect(await store.listSettingChanges(10)).toHaveLength(4);
  });
});

describe("factory settings reset --learned and the Settings page: one check (design 08-settings)", () => {
  const ui = async (store: FactoryStore, refusal: string | null) => {
    const clock = new FakeClock();
    const settings: UiSettings = {
      base, repo: { owner: "o", name: "r" }, actor: "local:owner", resolveProject: async () => PROJECT, csrfToken: newCsrfToken(), mayApproveMerge: async () => refusal,
    };
    const d: UiDeps = { store, scanner: new PatternEgressScanner(async () => []), clock, lease_ms: 300_000, health: new HealthMonitor(async () => [], clock), settings };
    return writeSettings(d, settings, { action: "reset", key: "max_diff_lines", project: "o/r", learned: true });
  };
  const cliReset = (store: FactoryStore, refusal: string | null) => run({ ...deps(store), mayApproveMerge: async () => refusal }, "reset", "max_diff_lines", "--project", "o/r", "--learned");
  const learn = (store: FactoryStore, value: number) =>
    store.setLearnedSetting({ project: PROJECT.key, key: "max_diff_lines", expected: null, value: String(value), evidence_run_ids: [], window_end: "2026-03-05T00:00:00.000Z" as Timestamp, actor: "improver" });
  const NO = "the requester role cannot approve_merge";

  it("a loosening reset without approve_merge is refused by both, with the same message and no audit row", async () => {
    const { store } = await newStore();
    await learn(store, 800);
    const cli = await cliReset(store, NO);
    expect(cli.ok).toBe(false);
    expect(cli.lines).toEqual([`refused: resetting the learned max_diff_lines for ${PROJECT.label} loosens it from 800 to 1500 and needs approve_merge on the project: ${NO}`]);
    const page = await ui(store, NO);
    expect(page).toEqual({ status: 422, value: { error: cli.lines.join("\n") } });
    expect(await store.getLearnedSetting(PROJECT.key, "max_diff_lines")).toMatchObject({ value: "800" });
    expect(await store.listLearnedSettingChanges(10)).toHaveLength(1); // the learned write's row only
  });

  it("with approve_merge the page clears the value with one audit row naming the actor", async () => {
    const { store } = await newStore();
    await learn(store, 800);
    const page = await ui(store, null);
    expect(page.status).toBe(200);
    expect(await store.getLearnedSetting(PROJECT.key, "max_diff_lines")).toBeNull();
    const [reset] = await store.listLearnedSettingChanges(10);
    expect(reset).toMatchObject({ project: PROJECT.key, key: "max_diff_lines", old_value: "800", new_value: null, actor: "local:owner" });
  });

  it("a reset that loosens nothing (the project override is tighter than the learned value) needs no approve_merge", async () => {
    const { store } = await newStore();
    await learn(store, 800);
    await store.setSettingOverride({ key: "max_diff_lines", project: PROJECT.key, value: "500", actor: "local:owner" });
    const cli = await cliReset(store, NO);
    expect(cli.ok).toBe(true);
    expect(await store.getLearnedSetting(PROJECT.key, "max_diff_lines")).toBeNull();
  });
});

describe.each(BACKENDS)("factory settings: the live timing, coordination and intake keys (design 08-settings): $name", ({ make }) => {
  /** The config loader's own message for `value` of `key`: the coordination, stall, retry and intake label checks. */
  const loaderMessage = (key: string, value: unknown): string => {
    try {
      if (key === "stall_ms" || key === "probe_interval_ms") stallConfig({ [key]: value as number });
      else if (key === "auth_pause_ms") retryConfig({ auth_pause_ms: value as number });
      else if (key === "intake_label") intakeLabel(value);
      else coordinationConfig({ [key]: value });
    } catch (err) {
      return (err as Error).message;
    }
    throw new Error(`the loader accepts ${key} ${JSON.stringify(value)}`);
  };
  const VALID: [string, string][] = [
    ["stall_ms", "120000"], ["probe_interval_ms", "60000"], ["auth_pause_ms", "900000"],
    ["max_coordination_cost", "2"], ["hotspot_weight", "4"], ["mechanical_weight", "0.5"], ["intake_label", '"triage-me"'],
  ];

  it("each key is stored as one override and listed with source override", async () => {
    const { store } = await make();
    const d = deps(store);
    for (const [k, v] of VALID) {
      const r = await run(d, "set", k, v);
      expect(r.ok, k).toBe(true);
      expect(r.lines[0]!.startsWith(`${k} = ${v} (override; was `), r.lines[0]).toBe(true);
    }
    const rows = await store.listSettingOverrides();
    for (const [k, v] of VALID) expect(rows.filter((o) => o.key === k), k).toEqual([expect.objectContaining({ project: "", value: v })]);
    expect((await store.listSettingChanges(50)).map((c) => c.key).filter((k) => VALID.some(([v]) => v === k)).sort()).toEqual(VALID.map(([k]) => k).sort());
    const list = (await run(d, "list")).lines;
    for (const [k, v] of VALID) {
      expect(list.find((l) => l.trimStart().startsWith(`${k} `))!.trim().split(/\s+/), k).toEqual([k, "override", v]);
    }
  });

  it("branch_prefix stays file-only: refused as not settable, no override and no audit row", async () => {
    const { store } = await make();
    const r = await run(deps(store), "set", "branch_prefix", '"x/"');
    expect(r.ok).toBe(false);
    expect(r.lines[0]).toContain('"branch_prefix" is not settable');
    expect(await store.listSettingOverrides()).toEqual([]);
    expect(await store.listSettingChanges(10)).toEqual([]);
  });

  it("a refused value gets the config loader's own message and writes nothing", async () => {
    const { store } = await make();
    const d = deps(store);
    const bad: [string, unknown][] = [
      ["stall_ms", 0], ["stall_ms", 1.5], ["probe_interval_ms", -1], ["auth_pause_ms", 0], ["auth_pause_ms", "x"],
      ["max_coordination_cost", 0], ["max_coordination_cost", "x"], ["hotspot_weight", -1],
      ["mechanical_weight", 0], ["mechanical_weight", 1], ["mechanical_weight", 1.5], ["intake_label", ""], ["intake_label", 7],
    ];
    for (const [k, v] of bad) {
      expect(await run(d, "set", k, JSON.stringify(v)), `${k} ${JSON.stringify(v)}`).toEqual({ ok: false, lines: [`refused: ${loaderMessage(k, v)}`] });
    }
    expect(await store.listSettingOverrides()).toEqual([]);
    expect(await store.listSettingChanges(10)).toEqual([]);
  });

  it("timing keys and intake_label are free; tightening a coordination key needs no grant, loosening one asks approve_merge", async () => {
    const { store } = await make();
    let refusal: string | null = "the requester role cannot approve_merge";
    let asked = 0;
    const d: SettingsDeps = { ...deps(store, "local:dev"), mayApproveMerge: async () => (asked++, refusal) };
    // Free in both directions, and tighter coordination: never asked.
    for (const [k, v] of [
      ["stall_ms", "1"], ["stall_ms", "9000000"], ["probe_interval_ms", "1"], ["probe_interval_ms", "9000000"],
      ["auth_pause_ms", "1"], ["auth_pause_ms", "9000000"], ["intake_label", '"a"'], ["intake_label", '"b"'],
      ["max_coordination_cost", "2"], ["hotspot_weight", "4"], ["mechanical_weight", "0.5"],
    ] as const) {
      expect((await run(d, "set", k, v)).ok, `${k} ${v}`).toBe(true);
    }
    expect(asked).toBe(0);
    const written = (await store.listSettingChanges(50)).length;
    // Looser: a higher cost, lower weights, and a reset back to the looser default.
    for (const args of [
      ["set", "max_coordination_cost", "3"], ["set", "hotspot_weight", "3.5"], ["set", "mechanical_weight", "0.3"], ["reset", "hotspot_weight"],
    ]) {
      const r = await run(d, ...args);
      expect(r.ok, args.join(" ")).toBe(false);
      expect(r.lines[0]).toMatch(/^refused: loosening \S+ from .* needs approve_merge on the project: the requester role cannot approve_merge$/);
    }
    expect(asked).toBe(4);
    expect(await store.listSettingChanges(50)).toHaveLength(written);
    expect(await store.listSettingOverrides()).toContainEqual(expect.objectContaining({ key: "max_coordination_cost", value: "2" }));
    // With the grant: allowed.
    refusal = null;
    expect((await run(d, "set", "max_coordination_cost", "3")).ok).toBe(true);
  });
});

describe("settings edit-file: the CLI action and the Settings write route run the same writer", () => {
  it("parses edit-file <key> <json> [--confirm]; anything else is an error", () => {
    expect(parseSettingsArgs(["edit-file", "floors", "[]"])).toEqual({ action: "edit-file", key: "floors", value: "[]", confirm: false });
    expect(parseSettingsArgs(["edit-file", "floors", "[]", "--confirm"])).toEqual({ action: "edit-file", key: "floors", value: "[]", confirm: true });
    for (const bad of [["edit-file", "floors"], ["edit-file", "floors", "[]", "x"], ["edit-file", "floors", "[]", "--project", "o/r"], ["set", "workers", "2", "--confirm"]]) {
      expect(parseSettingsArgs(bad), bad.join(" ")).toEqual({ error: expect.any(String) });
    }
  });

  it("both pass the request to the one writer; a refusal is the CLI's refused line and the route's 422", async () => {
    const { store, clock } = await newStore(new FakeClock());
    const asked: ConfigEditRequest[] = [];
    const editFile = async (r: ConfigEditRequest): Promise<ConfigEditResult> => {
      asked.push(r);
      return r.confirm
        ? { ok: true, item: "wi_1" as WorkItemId, branch: "factory/wi_1", sha: "a".repeat(40), old_value: "[]", new_value: r.value }
        : { ok: false, refusal: `${r.key} is loosening-sensitive` };
    };
    const cli = await run({ ...deps(store), editFile }, "edit-file", "floors", "[]");
    expect(cli).toEqual({ ok: false, lines: ["refused: floors is loosening-sensitive"] });
    expect((await run({ ...deps(store), editFile }, "edit-file", "floors", "[]", "--confirm")).lines[0]).toContain("on the local branch factory/wi_1");
    // Without a writer wired, the action is refused.
    expect((await run(deps(store), "edit-file", "floors", "[]")).ok).toBe(false);

    const settings: UiSettings = { base, repo: { owner: "o", name: "r" }, actor: "local:owner", resolveProject: async () => null, csrfToken: newCsrfToken(), editFile };
    const d: UiDeps = { store, scanner: new PatternEgressScanner(async () => []), clock, lease_ms: 300_000, health: new HealthMonitor(async () => [], clock), settings };
    const refused = await writeSettings(d, settings, { action: "edit-file", key: "floors", value: "[]" });
    expect(refused).toEqual({ status: 422, value: { error: "refused: floors is loosening-sensitive" } });
    expect((await writeSettings(d, settings, { action: "edit-file", key: "floors", value: "[]", confirm: true })).status).toBe(200);
    expect((await writeSettings(d, settings, { action: "edit-file", key: "floors", value: "[]", confirm: "yes" })).status).toBe(400);
    expect((await writeSettings(d, settings, { action: "set", key: "workers", value: "2", confirm: true })).status).toBe(400);
    expect(asked).toEqual([
      { key: "floors", value: "[]", confirm: false }, { key: "floors", value: "[]", confirm: true },
      { key: "floors", value: "[]", confirm: false }, { key: "floors", value: "[]", confirm: true },
    ]);
  });

  it("the route sits behind the Settings write guards (Host, Origin, Content-Type, x-csrf-token), each before the writer", async () => {
    const { store, clock } = await newStore(new FakeClock());
    let calls = 0;
    const editFile = async (): Promise<ConfigEditResult> => (calls++, { ok: false, refusal: "no" });
    const settings: UiSettings = { base, repo: { owner: "o", name: "r" }, actor: "local:owner", resolveProject: async () => null, csrfToken: newCsrfToken(), editFile };
    const d: UiDeps = { store, scanner: new PatternEgressScanner(async () => []), clock, lease_ms: 300_000, health: new HealthMonitor(async () => [], clock), settings };
    const HOST = "127.0.0.1:4310";
    const post = (over: Partial<UiRequest>): UiRequest => ({
      method: "POST", url: SETTINGS_PATH, host: HOST, origin: `http://${HOST}`, contentType: "application/json", csrfToken: settings.csrfToken,
      body: JSON.stringify({ action: "edit-file", key: "floors", value: "[]", confirm: true }), ...over,
    });
    for (const [over, status] of [
      [{ host: "evil.example" }, 403], [{ origin: "http://evil.example" }, 403], [{ contentType: "text/plain" }, 415],
      [{ csrfToken: undefined }, 403], [{ csrfToken: newCsrfToken() }, 403],
    ] as [Partial<UiRequest>, number][]) {
      expect((await respond(d, post(over))).status, JSON.stringify(over)).toBe(status);
    }
    expect(calls).toBe(0);
    expect((await respond(d, post({}))).status).toBe(422);
    expect(calls).toBe(1);
  });
});
