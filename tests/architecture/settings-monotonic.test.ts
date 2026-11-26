import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { isGatePath } from "../../src/core/improver.js";
import { keyRefusal, resolveSettings } from "../../src/core/settings.js";
import { SettingCatalog, loadSettingCatalog, monotonicProblems, renderSettingCatalog } from "../../src/runtime/index.js";
import { resolveLevels } from "../../src/runtime/settings/monotonic.js";
import { type SettingDescriptor, settingFileName, settingProblems } from "../../src/shared/setting.js";
import { REPO, componentOf } from "./lib.js";

// RFC 0015 §8, §9 settings-monotonic: a lower settings level never loosens what a higher one set; runtime
// changes (`factory settings set`) never touch a guard, and loosen a dial only with its grant; floors, dials and
// guards otherwise change by a reviewed config change only. Also the settings layout, the gate list over every
// setting file, and the generated catalog (the index docs/settings.md and one page per owner under docs/settings/;
// `npm run settings:catalog` rewrites them).

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

/**
 * A project value looser than the global one (with the global override it is looser than, or null for the default)
 * and one tighter than the default. A number: its default +1 and -1. A boolean switch such as
 * auto_grant_test_paths, default on: true is looser than a global false, and false is tighter.
 */
function projectSample(s: SettingDescriptor): { global: string | null; looser: string; tighter: string } {
  if (s.type === "boolean") return { global: "false", looser: "true", tighter: "false" };
  return { global: null, looser: String((s.default as number) + 1), tighter: String((s.default as number) - 1) };
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
      const { global, looser, tighter } = projectSample(s);
      const above = global === null ? [] : [{ key: s.key, project: "", value: global }];
      const r = resolveSettings(base, [...above, { key: s.key, project: "p1", value: looser }]);
      expect(r.ignored.map((i) => i.key), s.key).toEqual([s.key]);
      expect(resolveSettings(base, [{ key: s.key, project: "p1", value: tighter }]).ignored, s.key).toEqual([]);
    }
  });

  it("every owner page holds only that owner's rows, and every key sits in exactly one page", () => {
    const pages = renderSettingCatalog(catalog);
    const index = pages.get("docs/settings.md")!;
    expect(index, "the index holds no setting rows").not.toMatch(/^\| `/m);
    const owners = [...new Set(catalog.all().map((s) => s.owner))].sort();
    expect(owners).toEqual(expect.arrayContaining(["controller", "guards", "inbound", "outbound", "runtime", "state", "worker"]));
    const seen: string[] = [];
    for (const owner of owners) {
      const page = pages.get(`docs/settings/${owner}.md`);
      expect(page, owner).toBeDefined();
      expect(index).toContain(`(settings/${owner}.md)`);
      for (const row of page!.split("\n").filter((l) => l.startsWith("| `"))) {
        expect(row.split(" | ")[1], row).toBe(owner);
        seen.push(row.slice(3, row.indexOf("`", 3)));
      }
    }
    expect(seen.sort()).toEqual(catalog.all().map((s) => s.key).sort());
  });

  it("the index does not change when a setting's default or description changes", () => {
    const [first, ...rest] = catalog.entries;
    const changed = { ...first!, descriptor: { ...first!.descriptor, default: "other", description: "Something else." } };
    const before = renderSettingCatalog(catalog).get("docs/settings.md");
    expect(renderSettingCatalog(new SettingCatalog([changed, ...rest])).get("docs/settings.md")).toBe(before);
  });

  it("docs/settings.md and docs/settings/<owner>.md are the generated catalog", () => {
    const pages = renderSettingCatalog(catalog);
    const dir = join(REPO, "docs", "settings");
    if (process.env.SF_SNAPSHOT_UPDATE === "1") {
      mkdirSync(dir, { recursive: true });
      for (const f of readdirSync(dir)) if (f.endsWith(".md") && !pages.has(`docs/settings/${f}`)) rmSync(join(dir, f));
      for (const [rel, text] of pages) writeFileSync(join(REPO, rel), text);
    }
    for (const [rel, text] of pages) {
      expect(existsSync(join(REPO, rel)), `${rel} is missing: run npm run settings:catalog`).toBe(true);
      expect(text, `${rel} is stale: run npm run settings:catalog`).toBe(readFileSync(join(REPO, rel), "utf8"));
    }
    const extra = readdirSync(dir).filter((f) => f.endsWith(".md") && !pages.has(`docs/settings/${f}`));
    expect(extra, "pages for no owner: run npm run settings:catalog").toEqual([]);
  });
});
