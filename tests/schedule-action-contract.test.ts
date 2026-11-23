// The ScheduleAction plugin kind (design 08-schedules, phase 2): an action folder is discovered with no loader
// change; the kind has no default; with plugins.schedule_action unset nothing is selected; an unknown name fails at
// startup, naming the interface and the available names.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { PLUGIN_ROOT, REGISTRY, loadRegistry, selectPlugins } from "../src/plugins.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const REAL = JSON.parse(readFileSync(join(REPO_ROOT, "factory.config.json"), "utf8")) as Record<string, unknown>;
const API_URL = pathToFileURL(join(REPO_ROOT, "src", "plugin-api.ts")).href;

/** A temp folder with one schedule_action descriptor; `extra` adds fields to its definePlugin call. */
function actionDir(name = "fixture-action", extra = ""): string {
  const dir = mkdtempSync(join(tmpdir(), "sf-schedule-action-"));
  writeFileSync(
    join(dir, `${name}.plugin.ts`),
    `import { definePlugin } from ${JSON.stringify(API_URL)};\n` +
      `export default definePlugin({ kind: "schedule_action", name: ${JSON.stringify(name)}, create: () => ({ run: async () => {} })${extra} });\n`,
  );
  return dir;
}

const failure = (p: Promise<unknown>) => p.then(() => null, (e: Error) => e.message);

describe("the schedule_action plugin kind", () => {
  it("a folder with a *.plugin.ts descriptor of kind schedule_action is discovered as an action", async () => {
    const registry = await loadRegistry([PLUGIN_ROOT, actionDir()]);
    expect(registry.schedule_action.interface).toBe("ScheduleAction");
    expect(registry.schedule_action.configKey).toBe("plugins.schedule_action");
    expect(Object.keys(registry.schedule_action.plugins)).toContain("fixture-action");
  });

  it("is optional, not a guard, and a descriptor with a default is refused at startup", async () => {
    expect(REGISTRY.schedule_action.optional).toBe(true);
    expect(REGISTRY.schedule_action.guard).toBe(false);
    expect(REGISTRY.schedule_action.defaults).toEqual({ platforms: {} });
    expect(await failure(loadRegistry([PLUGIN_ROOT, actionDir("fixture-default", ", default: true")]))).toMatch(
      /schedule_action plugins take no default: ScheduleAction is optional, selected only by "plugins.schedule_action"/,
    );
  });

  it("with plugins.schedule_action unset no action is selected; set, the name is selected", async () => {
    const registry = await loadRegistry([PLUGIN_ROOT, actionDir()]);
    const raw = { store: { type: "sqlite" }, plugins: REAL.plugins };
    expect(selectPlugins(registry, raw).schedule_action).toBeUndefined();
    expect(selectPlugins(registry, { store: { type: "sqlite" } }).schedule_action).toBeUndefined();
    expect(selectPlugins(registry, { ...raw, plugins: { ...(REAL.plugins as object), schedule_action: "none" } }).schedule_action).toBeUndefined();
    expect(selectPlugins(registry, { ...raw, plugins: { ...(REAL.plugins as object), schedule_action: "fixture-action" } }).schedule_action).toBe("fixture-action");
  });

  it("an unknown name fails at startup, naming the ScheduleAction interface and the available names (the routed dispatcher among them)", async () => {
    const registry = await loadRegistry([PLUGIN_ROOT, actionDir()]);
    const raw = { store: { type: "sqlite" }, plugins: { ...(REAL.plugins as object), schedule_action: "no-such-action" } };
    expect(() => selectPlugins(registry, raw)).toThrow(/unknown ScheduleAction plugin "no-such-action" at plugins\.schedule_action; available: .*fixture-action/);
    expect(() => selectPlugins(REGISTRY, raw)).toThrow(/unknown ScheduleAction plugin "no-such-action" at plugins\.schedule_action; available: .*routed/);
  });
});
