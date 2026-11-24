// The responsive fixture's imported skill with its eval suite, two versions and one finished run per version, so the
// Evals page (evals/<skill>) draws two version rows (the newer one current) and its Compare dialog a diff and a case
// table. Kept apart from fixture.mjs, which imports dist/: the dependencies come in as `lib`, so the test of this seed
// (tests/responsive-fixture-evals.test.ts) runs it on src/ without a build.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SKILL_NAME = "fixture-review";
const SUITE = "suite_responsive_fixture";

const SKILL_TEXTS = [
  `---\ndescription: Reviews a change against the repository's rules and names each broken one.\n---\n\n# ${SKILL_NAME}\n`,
  `---\ndescription: Reviews a change against the repository's rules, names each broken one and the page and width it breaks at.\n---\n\n# ${SKILL_NAME}\n\nName the rule, the page and the width of each finding.\n`,
];

/** Per version: each of the two cases' verdicts (the run's pass rate is their pass share). */
const VERDICTS = [["pass", "fail"], ["pass", "pass"]];

/**
 * Seeds the skill folder `<dir>/skills/<name>`, its ref and suite with two cases, then each version of SKILL.md in turn:
 * written, its folder hash taken (`lib.skillVersion`, as eval runs store it), recorded (`recordSkillVersion`), and
 * one finished run bound to that hash with a replay per case and its figures. Returns the suite's skill_ref (the
 * skills folder joined with the name, as the Plugins page keys a suite).
 * `lib`: { SkillRefsStore, skillVersion, skillRefId, storeSql }, from dist/ or src/.
 */
export async function seedSkill(store, dir, owner, lib) {
  const folder = join(dir, "skills");
  const skillFolder = join(folder, SKILL_NAME);
  const path = join(skillFolder, "SKILL.md");
  const skill_ref = `${folder}/${SKILL_NAME}`;
  mkdirSync(skillFolder, { recursive: true });
  const refs = new lib.SkillRefsStore(lib.storeSql(store), () => new Date().toISOString());
  await store.createSkillEvalSuite({ id: SUITE, skill_ref, title: "Fixture suite", created_by: owner });
  const cases = [];
  for (const n of [1, 2]) cases.push(await store.addSkillEvalCase({ id: `case_responsive_${n}`, suite_id: SUITE, input: { change: `Change ${n}` }, expected: { rule: `Rule ${n}` } }));

  for (const [i, text] of SKILL_TEXTS.entries()) {
    writeFileSync(path, text);
    const sha256 = createHash("sha256").update(text).digest("hex");
    const found = { source: "claude", kind: "skill", name: SKILL_NAME, path, sha256 };
    await refs.insert(found, owner);
    const folder_hash = await lib.skillVersion(skillFolder);
    if (!(await store.recordSkillVersion({ ref_id: lib.skillRefId(found), folder_hash, text, source: "claude" }))) throw new Error(`fixture skill version ${i + 1} was not recorded`);
    const run = await store.startSkillEvalRun({ id: `run_responsive_${i + 1}`, suite_id: SUITE, created_by: owner, skill_version: folder_hash });
    for (const [c, verdict] of VERDICTS[i].entries()) await store.recordSkillEvalReplay({ run_id: run.id, case_id: cases[c].id, verdict, detail: {} });
    await store.finishSkillEvalRun(run.id, VERDICTS[i].includes("fail") ? "failed" : "passed");
    const passed = VERDICTS[i].filter((v) => v === "pass").length;
    await store.recordSkillEvalRunFigures(run.id, { model_class: "standard", judge_model_class: "strong", replays: VERDICTS[i].length, pass_rate: passed / VERDICTS[i].length, errored: 0 });
  }
  return skill_ref;
}
