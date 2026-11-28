import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { isGatePath } from "../../src/core/improver.js";
import { SettingCatalog, loadSettingCatalog, renderSettingCatalog } from "../../src/runtime/index.js";
import { settingFileName, settingProblems } from "../../src/shared/setting.js";
import { REPO, componentOf } from "./lib.js";

// RFC 0015 §8, §9 settings-monotonic: the settings layout, the gate list over every setting file, and the
// generated catalog (the index docs/settings.md and one page per owner under docs/settings/;
// `npm run settings:catalog` rewrites them). The order checks (tighten-only, guards, dials, project resolver)
// are in settings-tightening.test.ts.

let catalog: SettingCatalog;
beforeAll(async () => {
  catalog = await loadSettingCatalog();
});

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
