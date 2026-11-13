import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveCalendars } from "../../src/calendar/index.js";
import { build, loadConfig, settingsBase } from "../../src/compose.js";
import { OWNER_KEYS, parseSettable, resolveSettings } from "../../src/core/settings.js";
import { FakeClock } from "../../src/impl/clock/fake-clock.js";
import { REGISTRY, withPlugin } from "../../src/plugins.js";
import { fakeRepoLookup } from "../helpers/fakes.js";
import { FakeCalendarSource } from "./fakes.js";

// The live `calendar` setting (design 08-settings, 2026-11-13): an owner-only list of calendar plugin names over the
// file's `calendar` key, handed by each process's LiveSettings to its LiveCalendars after every refresh, so a calendar
// connected from the dashboard or the terminal syncs from the next tick with no restart.

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const REAL = JSON.parse(readFileSync(join(REPO_ROOT, "factory.config.json"), "utf8")) as Record<string, unknown>;

afterEach(() => {
  vi.unstubAllEnvs();
});

function holder(build: (name: string) => Promise<FakeCalendarSource>) {
  const warned: { msg: string; fields: Record<string, string> }[] = [];
  return { live: new LiveCalendars(build, { warn: (msg, fields) => void warned.push({ msg, fields }) }), warned };
}

describe("the calendar setting", () => {
  it("is owner-only and takes a list of distinct non-empty names, [] for none", () => {
    expect(OWNER_KEYS).toContain("calendar");
    expect(parseSettable("calendar", [])).toEqual([]);
    expect(parseSettable("calendar", ["work", "google-calendar"])).toEqual(["work", "google-calendar"]);
    for (const bad of ["work", ["work", "work"], [""], [3], null]) {
      expect(() => parseSettable("calendar", bad), JSON.stringify(bad)).toThrow(/^calendar must be a list of distinct calendar plugin names/);
    }
  });

  it("an override wins over the file's key; with none the file's key applies", () => {
    const base = { file: { calendar: ["work"] }, layers: { defaults: {}, projects: {} } } as unknown as Parameters<typeof resolveSettings>[0];
    expect(resolveSettings(base, []).values.calendar).toEqual(["work"]);
    expect(resolveSettings(base, [{ key: "calendar", project: "", value: '["work","google-calendar"]' }]).values.calendar).toEqual(["work", "google-calendar"]);
    expect(resolveSettings(base, [{ key: "calendar", project: "", value: "[]" }]).values.calendar).toEqual([]);
  });
});

describe("LiveCalendars", () => {
  it("builds a joining name, keeps a staying one's source, drops a leaving one, in the list's order, in the same array", async () => {
    const built: string[] = [];
    const { live } = holder(async (name) => (built.push(name), new FakeCalendarSource()));
    const feeds = live.feeds;
    await live.apply(["a"]);
    const a = feeds[0]!.source;
    await live.apply(["b", "a"]);
    expect(feeds.map((f) => f.name)).toEqual(["b", "a"]);
    expect(feeds[1]!.source).toBe(a);
    await live.apply(["b", "a"]);
    await live.apply(["b"]);
    expect(feeds.map((f) => f.name)).toEqual(["b"]);
    expect(built).toEqual(["a", "b"]);
    expect(live.feeds).toBe(feeds);
  });

  it("a build that fails on the first list fails startup; later it logs once and the other names still sync", async () => {
    const { live: first } = holder(async () => {
      throw new Error("calendar_ids must be a list");
    });
    await expect(first.apply(["bad"])).rejects.toThrow(/calendar_ids must be a list/);

    const { live, warned } = holder(async (name) => {
      if (name === "bad") throw new Error("no such plugin");
      return new FakeCalendarSource();
    });
    await live.apply([]);
    await live.apply(["good", "bad"]);
    await live.apply(["good", "bad"]);
    expect(live.feeds.map((f) => f.name)).toEqual(["good"]);
    expect(warned).toEqual([{ msg: "calendar source could not be built; it is not synced", fields: { source: "bad", error: "no such plugin" } }]);
  });

  it("build(): the controller's list follows a stored override after the next settings refresh, with no restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-live-calendar-"));
    mkdirSync(join(dir, "prompts"));
    for (const p of ["triage", "implement", "review", "resolve"]) writeFileSync(join(dir, "prompts", `${p}.md`), p);
    writeFileSync(join(dir, "factory.config.json"), JSON.stringify({ ...REAL, store: { type: "sqlite" }, state_dir: "state", worktrees_dir: "wt" }));
    mkdirSync(join(dir, "secrets"));
    writeFileSync(join(dir, "secrets", ".env"), "GITHUB_TOKEN=gh\n");
    vi.stubEnv("SOFTWARE_FACTORY_SECRETS_FILE", join(dir, "secrets", ".env"));
    const source = new FakeCalendarSource();
    const loaded = await loadConfig(dir, { registry: withPlugin(REGISTRY, "calendar", "work", () => source) });
    expect(resolveSettings(settingsBase(loaded), []).values.calendar).toEqual([]);
    const built = await build(loaded, { clock: new FakeClock(), repoLookup: fakeRepoLookup });
    try {
      const d = built.controller.kernel.d as typeof built.controller.kernel.d & { settings: { refresh(): Promise<void> } };
      const feeds = d.calendar!;
      expect(feeds).toEqual([]);
      await built.store.setSettingOverride({ key: "calendar", project: "", value: '["work"]', actor: "local:owner" });
      await d.settings.refresh();
      expect(d.calendar).toBe(feeds);
      expect(feeds).toEqual([{ name: "work", source }]);
      await built.store.setSettingOverride({ key: "calendar", project: "", value: "[]", actor: "local:owner" });
      await d.settings.refresh();
      expect(feeds).toEqual([]);
    } finally {
      await built.close();
    }
  });
});
