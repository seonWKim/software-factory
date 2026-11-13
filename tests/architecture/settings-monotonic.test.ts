import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { isGatePath } from "../../src/core/improver.js";
import { keyRefusal, resolveSettings } from "../../src/core/settings.js";
import { type SettingCatalog, loadSettingCatalog, monotonicProblems, renderSettingCatalog, resolveLevels } from "../../src/runtime/index.js";
import { type SettingDescriptor, settingFileName, settingProblems } from "../../src/shared/setting.js";
import { REPO, componentOf } from "./lib.js";

// RFC 0015 §8, §9 settings-monotonic: a lower settings level never loosens what a higher one set; runtime
// changes (`factory settings set`) never touch a guard, and loosen a dial only with its grant; floors, dials and
// guards otherwise change by a reviewed config change only. Also the settings layout, the gate list over every
// setting file, and the generated catalog (docs/settings.md; `npm run settings:catalog` rewrites it).

let catalog: SettingCatalog;
beforeAll(async () => {
  catalog = await loadSettingCatalog();
});

/** A value looser than `than`, for settings whose order is a function (a new one must add its sample here). */
const LOOSER: Readonly<Record<string, { than: unknown; looser: unknown }>> = {
  floors: { than: [{ prefix: "src/", tier: 4 }], looser: [] },
  dials: { than: { spec_gate_min_tier: 1, auto_merge_max_tier: 0 }, looser: { spec_gate_min_tier: 1, auto_merge_max_tier: 1 } },
  tool_grants: { than: { triage: ["forge.preflight"] }, looser: { triage: ["forge.preflight"], review: ["forge.preflight"] } },
};

/** A pair (value set above, a looser value below) for a tighten-only setting. */
function looserPair(s: SettingDescriptor): { than: unknown; looser: unknown } {
  const t = s.tighter!;
  if (typeof t === "function") {
    const sample = LOOSER[s.key];
    if (!sample) throw new Error(`${s.key}: add a looser sample to LOOSER in settings-monotonic.test.ts`);
    return sample;
  }
  if (t === "lower") return { than: 2, looser: 3 };
  if (t === "higher") return { than: 3, looser: 2 };
  if (t === "more") return { than: ["/a", "/b"], looser: ["/a"] };
  if (t === "fewer") return { than: ["a"], looser: ["a", "b"] };
  if (t === "fixed") return { than: "a", looser: "b" };
  return { than: t[0], looser: t[t.length - 1] };
}

describe("settings-monotonic", () => {
  it("every setting is consistent and sits at src/<owner>/settings/<key>.setting.ts, on the gate list", () => {
    const bad: string[] = [];
    for (const { file, descriptor: s } of catalog.entries) {
      bad.push(...settingProblems(s));
      if (file !== join(s.owner, "settings", `${settingFileName(s.key)}.setting.ts`)) bad.push(`${file}: expected src/${s.owner}/settings/${settingFileName(s.key)}.setting.ts`);
      if (componentOf(file) !== s.owner) bad.push(`${file}: owner ${s.owner} is not a component folder`);
      if (!isGatePath(`src/${file}`)) bad.push(`src/${file}: not on the gate list (PROTECTED_PATHS.guard_settings in src/core/standing.ts)`);
    }
    expect(bad).toEqual([]);
  });

  it("a lower level that loosens a tighten-only setting is refused, and an equal value is kept", () => {
    for (const s of catalog.all().filter((x) => x.direction === "tighten-only" && !x.guard)) {
      const { than, looser } = looserPair(s);
      expect(monotonicProblems(s, [{ level: "owner", value: than }, { level: "project", value: looser }]), s.key).toHaveLength(1);
      expect(monotonicProblems(s, [{ level: "owner", value: than }, { level: "pack", value: than }]), s.key).toEqual([]);
      expect(resolveLevels(s, [{ level: "user", value: looser }, { level: "owner", value: than }]).value, s.key).toEqual(than);
    }
  });

  it("guards are set by the owner's reviewed config only, and no runtime change reaches one", () => {
    const guards = catalog.all().filter((s) => s.guard);
    expect(guards.map((s) => s.key).sort()).toEqual(["broker", "deny_paths", "egress", "secrets"]);
    for (const s of guards) {
      expect(s.changed_by, s.key).toBe("review");
      expect(keyRefusal(s.key), s.key).toMatch(/changes by PR only/);
      const { than } = looserPair(s);
      expect(resolveLevels(s, [{ level: "owner", value: than }, { level: "project", value: than }]).level, s.key).toBe("owner");
    }
  });

  it("a dial loosens at runtime only with its grant; every other dial changes by review only", () => {
    for (const s of catalog.all().filter((x) => x.dial)) {
      if (s.changed_by === "runtime") expect(s.change_needs, s.key).toBe("approve_merge");
      else expect(keyRefusal(s.key), s.key).toMatch(/changes by PR only/);
    }
  });

  it("the running resolver ignores a project override that loosens a tighten-only project setting", () => {
    const base = { file: {}, layers: { defaults: {}, projects: {} } };
    const keys = catalog.all().filter((s) => s.scope === "project" && s.changed_by === "runtime" && s.direction === "tighten-only");
    expect(keys.length).toBeGreaterThan(0);
    for (const s of keys) {
      const looser = String((s.default as number) + 1);
      const r = resolveSettings(base, [{ key: s.key, project: "p1", value: looser }]);
      expect(r.ignored.map((i) => i.key), s.key).toEqual([s.key]);
      const tighter = String((s.default as number) - 1);
      expect(resolveSettings(base, [{ key: s.key, project: "p1", value: tighter }]).ignored, s.key).toEqual([]);
    }
  });

  it("docs/settings.md is the generated catalog", () => {
    const path = join(REPO, "docs", "settings.md");
    const actual = renderSettingCatalog(catalog);
    if (process.env.SF_SNAPSHOT_UPDATE === "1") writeFileSync(path, actual);
    expect(existsSync(path), "run npm run settings:catalog").toBe(true);
    expect(actual, "docs/settings.md is stale: run npm run settings:catalog").toBe(readFileSync(path, "utf8"));
  });
});
