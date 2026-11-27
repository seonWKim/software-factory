// The Evals part of the responsive fixture (seedSkill in scripts/responsive/fixture.mjs): the fixture skill has two
// versions with different SKILL.md texts, the newer one current, and a finished run with a pass rate bound to each
// version's folder hash, so the Evals page's Compare and SKILL.md diff Cards have something to draw.
// fixture.mjs imports dist/, which a test run has not built: the test loads a copy of it whose dist/ imports point at src/.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { skillVersionRows } from "../src/core/skill-eval-compare.js";
import { storeSql } from "../src/impl/store/sql/store-sql.js";
import { newStore } from "./helpers/store.js";

const ROOT = join(import.meta.dirname, "..");

async function loadFixture(dir: string): Promise<{ seedSkill(store: unknown, dir: string): Promise<string> }> {
  const text = readFileSync(join(ROOT, "scripts", "responsive", "fixture.mjs"), "utf8").replaceAll('"../../dist/', `"${join(ROOT, "src")}/`);
  const file = join(dir, "fixture.mjs");
  writeFileSync(file, text);
  return import(pathToFileURL(file).href);
}

let dir = "";
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("responsive fixture: the Evals page's skill", () => {
  it("has two versions with different texts, the newer current, and a finished run with a pass rate bound to each", async () => {
    dir = mkdtempSync(join(tmpdir(), "sf-fixture-evals-"));
    const { seedSkill } = await loadFixture(dir);
    const { store } = await newStore();
    const skill = await seedSkill(store, dir);

    const runs = await store.listSkillEvalRuns(skill);
    const [hit] = await storeSql(store).all("SELECT ref_id FROM ext_skill_versions", []);
    const versions = await store.listSkillVersions(String(hit!.ref_id));
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    expect(versions[0]!.text).not.toBe(versions[1]!.text);
    expect(versions[0]!.folder_hash).not.toBe(versions[1]!.folder_hash);

    const rows = skillVersionRows(versions, runs);
    expect(rows.map((r) => r.version)).toEqual([2, 1]);
    expect(rows.map((r) => r.current)).toEqual([true, false]);
    for (const r of rows) {
      expect(r.pass_rate).not.toBeNull();
      const run = runs.find((x) => x.id === r.run_id)!;
      expect(run.skill_version).toBe(r.folder_hash);
      expect(run.finished_at).not.toBeNull();
    }
  });
});

describe("check:responsive: the Evals entries", () => {
  it("load a page the server serves and move to evals/<skill> in place, since a full load of a folder-path skill is a 404", () => {
    const check = readFileSync(join(ROOT, "scripts", "responsive-check.mjs"), "utf8");
    expect(check).toContain('{ name: "evals", path: "data" }');
    expect(check).toContain("evals: openEvals(fixture.pages.skill),");
    expect(check).toMatch(/history\.pushState\(null, "", \$\{JSON\.stringify\(`\/app\/evals\//);
    expect(check).toContain('document.querySelector("[data-skill-diff]")');
  });

  it("have no evals-compare capture: the page's own capture shows Compare, with no Compare Button to press or dialog to wait for", () => {
    const check = readFileSync(join(ROOT, "scripts", "responsive-check.mjs"), "utf8");
    expect(check).not.toContain("evals-compare");
    expect(check).not.toContain("dialog[open] table");
  });
});
