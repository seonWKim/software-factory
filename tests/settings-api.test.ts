// The Settings API's learned layer (design 08-settings): GET /api/v1/settings resolves each per-project key through
// settingsFor and returns each learned value with its layer, evidence run IDs and set time; POST resets one.

import { describe, expect, it } from "vitest";
import { saveProjectLabel } from "../src/core/project-labels.js";
import type { SettingsBase } from "../src/core/settings.js";
import type { RunId, Timestamp } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { HealthMonitor } from "../src/ui/health.js";
import { type UiSettings, newCsrfToken, parseWrite, readSettings, storeProjectResolver } from "../src/ui/settings-api.js";
import type { UiDeps } from "../src/ui/server.js";
import { PROJECT } from "./helpers/fakes.js";
import { newStore } from "./helpers/store.js";

/** The file: max_diff_lines 1000 for every project, and o/r's block with max_diff_files 10. */
const base: SettingsBase = { file: {}, layers: { defaults: { max_diff_lines: 1000 }, projects: { "o/r": { max_diff_files: 10 } } } };
const EVIDENCE = ["run_a1", "run_b2", "run_c3"] as RunId[];

async function setup() {
  const clock = new FakeClock("2026-03-05T06:00:00.000Z");
  const { store } = await newStore(clock);
  await saveProjectLabel(store, PROJECT);
  const settings: UiSettings = {
    base, repo: { owner: "o", name: "r" }, actor: "local:owner", resolveProject: storeProjectResolver(store, { owner: "o", name: "r" }), csrfToken: newCsrfToken(),
  };
  const d: UiDeps = { store, scanner: new PatternEgressScanner(async () => []), clock, lease_ms: 300_000, health: new HealthMonitor(async () => [], clock), settings };
  return { clock, store, d, settings };
}

async function learn(store: FactoryStore, key: string, value: number, expected: string | null = null) {
  const c = await store.setLearnedSetting({
    project: PROJECT.key, key, expected, value: JSON.stringify(value), evidence_run_ids: EVIDENCE, window_end: "2026-03-05T00:00:00.000Z" as Timestamp, actor: "improver",
  });
  if (!c) throw new Error("no learned value written");
  return c;
}

type KeyRow = { key: string; learned: { project: string; value: string; source: string; evidence_run_ids: string[]; set_at: string }[] };

describe("GET /api/v1/settings: the learned layer", () => {
  it("returns a learned key with source learned, its value, its evidence run IDs and the time it was set", async () => {
    const { clock, store, d, settings } = await setup();
    const set_at = clock.now().toISOString();
    await learn(store, "max_diff_lines", 800);
    const v = await readSettings(d, settings);
    const row = (key: string) => (v.keys as unknown as KeyRow[]).find((k) => k.key === key)!;
    expect(row("max_diff_lines").learned).toEqual([{ project: PROJECT.label, value: "800", source: "learned", evidence_run_ids: EVIDENCE, set_at }]);
    // The file layer and the overrides stay as they were beside it; a key with no learned value has none.
    expect(row("max_diff_lines")).toMatchObject({ value: "1000", source: "file", file_value: "1000" });
    expect(row("max_diff_files").learned).toEqual([]);
    expect(JSON.stringify(v)).not.toContain(PROJECT.key);
  });

  it("a learned value looser than the project's override is shown with the layer in force", async () => {
    const { store, d, settings } = await setup();
    await learn(store, "max_diff_lines", 800);
    await store.setSettingOverride({ key: "max_diff_lines", project: PROJECT.key, value: "500", actor: "local:owner" });
    const v = await readSettings(d, settings);
    const row = (v.keys as unknown as KeyRow[]).find((k) => k.key === "max_diff_lines")!;
    expect(row.learned).toEqual([expect.objectContaining({ value: "800", source: "project" })]);
  });

  it("the evidence is the audit row that wrote the stored value, not an older one", async () => {
    const { clock, store, d, settings } = await setup();
    await learn(store, "max_diff_lines", 800);
    clock.advance(86_400_000);
    const newer = ["run_d4"] as RunId[];
    await store.setLearnedSetting({
      project: PROJECT.key, key: "max_diff_lines", expected: "800", value: "640", evidence_run_ids: newer, window_end: "2026-03-06T00:00:00.000Z" as Timestamp, actor: "improver",
    });
    const row = ((await readSettings(d, settings)).keys as unknown as KeyRow[]).find((k) => k.key === "max_diff_lines")!;
    expect(row.learned).toEqual([expect.objectContaining({ value: "640", evidence_run_ids: newer, set_at: clock.now().toISOString() })]);
  });
});

describe("POST /api/v1/settings: a learned reset", () => {
  it("takes learned: true on a reset with a project, as `settings reset --learned` does", () => {
    expect(parseWrite({ action: "reset", key: "max_diff_lines", project: "o/r", learned: true })).toEqual({ action: "reset", key: "max_diff_lines", project: "o/r", learned: true });
    expect(parseWrite({ action: "reset", key: "max_diff_lines", learned: true })).toEqual({ error: expect.stringContaining("--project") });
    expect(parseWrite({ action: "set", key: "max_diff_lines", value: "1", learned: true })).toEqual({ error: expect.any(String) });
    expect(parseWrite({ action: "reset", key: "max_diff_lines", project: "o/r", learned: "yes" })).toEqual({ error: expect.any(String) });
  });
});
