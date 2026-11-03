import { describe, expect, it } from "vitest";
import { saveProjectLabel } from "../src/core/project-labels.js";
import type { SettingsBase } from "../src/core/settings.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { type SettingsDeps, parseSettingsArgs, runSettings } from "../src/settings-cmd.js";
import { PROJECT } from "./helpers/fakes.js";
import { BACKENDS, PROJECT_KEY } from "./helpers/store.js";

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

  it("workers above the config file's workers is refused with the reason; nothing is written", async () => {
    const { store } = await make();
    const r = await run(deps(store), "set", "workers", "6");
    expect(r.ok).toBe(false);
    expect(r.lines[0]).toContain("workers 6 is above the config file's workers (5)");
    expect(await store.listSettingOverrides()).toEqual([]);
    expect(await store.listSettingChanges(10)).toEqual([]);
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
    for (const k of ["plugins", "repo", "store", "floors", "dials", "auth", "secrets", "egress", "broker"]) {
      const r = await run(d, "set", k, "{}");
      expect(r.ok).toBe(false);
      expect(r.lines[0]).toContain(`"${k}" changes by PR only`);
      expect((await run(d, "reset", k)).lines[0]).toContain("changes by PR only");
    }
    for (const k of ["budgets", "inbox_retention_days", "stats", "ui", "intake_label", "branch_prefix", "max_loop"]) {
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
    expect(list).toHaveLength(15 + 3);
    const line = (k: string) => list.find((l) => l.trimStart().startsWith(`${k} `))!.split(/\s+/).filter(Boolean);
    expect(line("tick_ms")).toEqual(["tick_ms", "override", "500"]);
    expect(line("workers")).toEqual(["workers", "file", "5"]);
    expect(line("max_attempts")).toEqual(["max_attempts", "file", "3"]);
    expect(line("run_timeout_ms")).toEqual(["run_timeout_ms", "default", "2700000"]);
    expect(list.slice(15)).toEqual([
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
