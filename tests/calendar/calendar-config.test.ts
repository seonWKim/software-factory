import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { build, loadConfig } from "../../src/compose.js";
import { TOP_LEVEL_KEYS } from "../../src/config-keys.js";
import { FakeClock } from "../../src/impl/clock/fake-clock.js";
import { PLUGINS_KEYS, REGISTRY, selectPlugins, selectedCalendars, withPlugin } from "../../src/plugins.js";
import { fakeRepoLookup } from "../helpers/fakes.js";
import { FakeCalendarSource } from "./fakes.js";

// The top-level `calendar` key (design 02-tasks, calendar): a list of CalendarSource plugin names, default [], checked
// at startup. No provider ships yet, so these tests register fake sources only.

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const REAL = JSON.parse(readFileSync(join(REPO_ROOT, "factory.config.json"), "utf8")) as Record<string, unknown>;
const SQLITE = { ...REAL, store: { type: "sqlite" } };

afterEach(() => {
  vi.unstubAllEnvs();
});

function root(config: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "sf-calendar-"));
  mkdirSync(join(dir, "prompts"));
  for (const p of ["triage", "implement", "review", "resolve"]) writeFileSync(join(dir, "prompts", `${p}.md`), p);
  writeFileSync(join(dir, "factory.config.json"), JSON.stringify({ ...config, state_dir: "state", worktrees_dir: "wt" }));
  mkdirSync(join(dir, "secrets"));
  writeFileSync(join(dir, "secrets", ".env"), "GITHUB_TOKEN=gh\n");
  vi.stubEnv("SOFTWARE_FACTORY_SECRETS_FILE", join(dir, "secrets", ".env"));
  return dir;
}

const withFake = (name: string) => withPlugin(REGISTRY, "calendar", name, () => new FakeCalendarSource());
const select = (registry: typeof REGISTRY, calendar: unknown) =>
  selectPlugins(registry, { store: { type: "sqlite" }, auth: "github", calendar }, { platform: "linux" });

describe("calendar config key", () => {
  it("is a top-level key, never a plugins key, registered as an optional kind with no plugin and no default", () => {
    expect(TOP_LEVEL_KEYS).toContain("calendar");
    expect(PLUGINS_KEYS).not.toContain("calendar");
    expect(REGISTRY.calendar).toMatchObject({ interface: "CalendarSource", configKey: "calendar", optional: true, guard: false });
    expect(REGISTRY.calendar.plugins).toEqual({});
    expect(REGISTRY.calendar.defaults).toEqual({ platforms: {} });
  });

  it("defaults to [] (no source): left out, or an empty list", async () => {
    expect(selectedCalendars(select(REGISTRY, undefined))).toEqual([]);
    expect(selectedCalendars(select(REGISTRY, []))).toEqual([]);
    expect(selectedCalendars((await loadConfig(root(SQLITE))).plugins)).toEqual([]);
  });

  it("selects the listed sources in config order", () => {
    const reg = withPlugin(withFake("work"), "calendar", "home", () => new FakeCalendarSource());
    expect(selectedCalendars(select(reg, ["home", "work"]))).toEqual(["home", "work"]);
  });

  it("an unknown name fails startup, naming the key and the available plugins", async () => {
    const err = await loadConfig(root({ ...SQLITE, calendar: ["outlook"] })).then(() => null, (e: Error) => e.message);
    expect(err).toContain("CalendarSource");
    expect(err).toContain('"outlook"');
    expect(err).toContain("at calendar");
    expect(err).toContain("available: none");
    const named = (() => {
      try {
        select(withFake("work"), ["wrok"]);
        return "";
      } catch (e) {
        return (e as Error).message;
      }
    })();
    expect(named).toContain("at calendar");
    expect(named).toContain("available: work");
  });

  it("a value that is not a list, a non-string entry or a name listed twice fails", () => {
    const reg = withFake("work");
    expect(() => select(reg, "work")).toThrow(/calendar must be a list of CalendarSource plugin names/);
    expect(() => select(reg, [1])).toThrow(/at calendar/);
    expect(() => select(reg, ["work", "work"])).toThrow(/^calendar lists "work" twice/);
  });

  it("`plugins.calendar` is an unknown plugins key that points to the top-level key", () => {
    expect(() => selectPlugins(REGISTRY, { store: { type: "sqlite" }, auth: "github", plugins: { calendar: [] } })).toThrow(
      /unknown plugins key "calendar"; calendar is selected by the top-level "calendar" key/,
    );
  });

  it("build() hands each selected source, by name, to the controller", async () => {
    const source = new FakeCalendarSource();
    const registry = withPlugin(REGISTRY, "calendar", "work", () => source);
    const loaded = await loadConfig(root({ ...SQLITE, calendar: ["work"] }), { registry });
    const built = await build(loaded, { clock: new FakeClock(), repoLookup: fakeRepoLookup });
    try {
      expect(built.controller.kernel.d.calendar).toEqual([{ name: "work", source }]);
    } finally {
      await built.close();
    }
  });
});
