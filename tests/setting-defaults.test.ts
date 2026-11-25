// One source for each setting's default: the `defineSetting` file. What `factory settings` and the Settings page
// show as a key's default must be that file's default, and the old literal copies in src/ stay deleted.

import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { SETTABLE_KEYS, type SettingsBase, resolveSettings } from "../src/core/settings.js";
import { loadSettingCatalog } from "../src/runtime/index.js";
import { runSettings } from "../src/settings-cmd.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { HealthMonitor } from "../src/ui/health.js";
import { newCsrfToken } from "../src/ui/settings-api.js";
import { type UiDeps, respond } from "../src/ui/server.js";
import { PROJECT } from "./helpers/fakes/config.js";
import { newStore } from "./helpers/store.js";

const catalog = await loadSettingCatalog();
const SRC = join(import.meta.dirname, "..", "src");
const NO_FILE: SettingsBase = { file: {}, layers: { defaults: {}, projects: {} } };

/** Every settable key whose setting file gives a default, with that default. */
const withDefault = SETTABLE_KEYS.flatMap((k) => {
  const d = catalog.get(k)?.default;
  return d === null || d === undefined ? [] : [[k, d] as const];
});

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === "golden" ? [] : sources(join(dir, e.name))) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
  );
}

describe("each setting's default comes from its setting file", () => {
  it("covers the named keys", () => {
    const keys = withDefault.map(([k]) => k);
    for (const k of ["retry_base_ms", "retry_max_ms", "max_restart", "run_timeout_ms", "lease_ms", "agent_stop_check_ms", "stall_ms"]) {
      expect(keys, k).toContain(k);
    }
  });

  it("the resolver's default (what `factory settings list` shows) is the setting file's default", async () => {
    const r = resolveSettings(NO_FILE, []);
    for (const [k, d] of withDefault) {
      expect(r.global[k].source, k).toBe("default");
      expect(r.global[k].raw, k).toEqual(d);
    }
    const { store } = await newStore(new FakeClock());
    const lines = (await runSettings({ store, base: NO_FILE, repo: { owner: "o", name: "r" }, actor: "local:cli", resolveProject: async () => PROJECT }, { action: "list" })).lines.join("\n");
    for (const [k, d] of withDefault) if (typeof d === "number") expect(lines, k).toMatch(new RegExp(`\\b${k.replace(".", "\\.")}\\b.*\\b${d}\\b`));
  });

  it("the Settings page's default_value is the setting file's default", async () => {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const d: UiDeps = {
      store,
      scanner: new PatternEgressScanner(async () => []),
      clock,
      lease_ms: 300_000,
      health: new HealthMonitor(async () => [], clock),
      settings: { base: NO_FILE, repo: { owner: "o", name: "r" }, actor: "local:test", resolveProject: async () => PROJECT, csrfToken: newCsrfToken() },
    };
    const r = await respond(d, { method: "GET", url: "/api/v1/settings", host: "127.0.0.1:4310" });
    expect(r.status).toBe(200);
    const rows = new Map<string, { default_value: string }>(JSON.parse(r.body).keys.map((row: { key: string; default_value: string }) => [row.key, row]));
    for (const [k, def] of withDefault) expect(rows.get(k)?.default_value, k).toBe(JSON.stringify(def));
  });

  it("the old copies are gone from src/: no RETRY_DEFAULTS, STOP_CHECK_MS or DEFAULT_STALL_MS, no named key given a number literal", () => {
    const found: string[] = [];
    const named = /\b(?:RETRY_DEFAULTS|STOP_CHECK_MS|DEFAULT_STALL_MS)\b|\b(?:retry_base_ms|retry_max_ms|max_restart|run_timeout_ms|lease_ms|agent_stop_check_ms|stall_ms)\s*:\s*[\d_]+\s*[,}]/;
    for (const file of sources(SRC)) {
      readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        if (named.test(line)) found.push(`${relative(SRC, file)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(found).toEqual([]);
  });
});
