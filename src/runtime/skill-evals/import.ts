// `factory eval import <skill> [--source <plugin>]` (design 06-measurement): copies a skill's cases from a
// SkillEvalSource into the skill's suite. Each case is stored as a local copy with id
// `import:<source>:<skill>:<source case id>`; a re-import stores only ids not stored yet, and a stored case keeps its
// input and expected. The source is only read, so an edit of an imported case never reaches it. Every new case passes
// the `case add` rule (validateCase) and the G5 egress scan before any is stored: one bad case stores none, and a
// finding is reported by rule name only. The source and store types are structural, so this component imports no
// legacy module.

import { type Authored, type AuthoredCase, type SkillEvalAuthoringStore, validateCase } from "./authoring.js";

/** A source as import reads it (the SkillEvalSource interface). */
export interface ImportSource {
  readonly enabled: boolean;
  listCases(skill: string): Promise<readonly { id: string; input: unknown; expected: unknown }[]>;
}

/** The egress scanner as import calls it: rule names on a finding, never the matched text. */
export interface ImportScanner {
  scan(channel: "log", content: string): Promise<{ clean: true } | { clean: false; findings: readonly { rule: string }[] }>;
}

export type SkillEvalImportStore = Pick<SkillEvalAuthoringStore, "listSkillEvalSuites" | "getSkillEvalCase" | "addSkillEvalCase">;

export interface SkillEvalImportDeps {
  store: SkillEvalImportStore;
  /** `plugins.eval_source`; absent when config selects none. */
  selected: string | undefined;
  /** Every registered SkillEvalSource plugin name. */
  registered: readonly string[];
  /** Builds the named source; called only with a registered name. */
  open(name: string): Promise<ImportSource>;
  /** Builds the configured egress scanner; called only when there is a new case to scan. */
  scanner(): Promise<ImportScanner>;
}

/** `--source`, when given; else the configured source. */
export interface SkillEvalImportRequest {
  skill: string;
  source?: string | undefined;
}

/** What one import stored: the new case ids, and the ids already stored (kept as they are). */
export interface ImportedCases {
  source: string;
  added: string[];
  kept: string[];
}

/** The id of an imported case's local copy. */
export const importedCaseId = (source: string, skill: string, sourceId: string): string => `import:${source}:${skill}:${sourceId}`;

export async function importSkillEvalCases(d: SkillEvalImportDeps, r: SkillEvalImportRequest): Promise<Authored<ImportedCases>> {
  const name = r.source ?? d.selected;
  if (name !== undefined && !d.registered.includes(name)) {
    return { refused: `unknown eval source ${JSON.stringify(name)}; available: ${d.registered.join(", ")}: nothing written` };
  }
  const source = name === undefined ? null : await d.open(name);
  if (name === undefined || !source?.enabled) {
    return { refused: "no eval source is on: set plugins.eval_source in factory.config.json or pass --source <plugin>: nothing written" };
  }
  const suite = (await d.store.listSkillEvalSuites()).find((s) => s.skill_ref === r.skill);
  if (!suite) return { refused: `no skill eval suite for ${r.skill}: nothing written` };
  let cases: Awaited<ReturnType<ImportSource["listCases"]>>;
  try {
    cases = await source.listCases(r.skill);
  } catch (err) {
    return { refused: `eval source ${name} cannot be read: ${err instanceof Error ? err.message : String(err)}: nothing written` };
  }
  const fresh: (AuthoredCase & { source_id: string })[] = [];
  const kept: string[] = [];
  const problems: string[] = [];
  for (const c of cases) {
    const id = importedCaseId(name, r.skill, c.id);
    if (kept.includes(id) || fresh.some((f) => f.id === id)) continue;
    if (await d.store.getSkillEvalCase(id)) {
      kept.push(id);
      continue;
    }
    const bad = validateCase({ input: c.input, expected: c.expected });
    if (bad) problems.push(`case ${c.id}: ${bad.replace(/: nothing written$/, "")}`);
    else fresh.push({ id, source_id: c.id, suite_id: suite.id, input: c.input, expected: c.expected });
  }
  if (fresh.length > 0) {
    const scanner = await d.scanner();
    for (const c of fresh) {
      const rules = new Set<string>();
      for (const text of [JSON.stringify(c.input), JSON.stringify(c.expected)]) {
        const found = await scanner.scan("log", text);
        if (!found.clean) for (const f of found.findings) rules.add(f.rule);
      }
      if (rules.size > 0) problems.push(`case ${c.source_id}: egress findings ${[...rules].join(", ")}`);
    }
  }
  if (problems.length > 0) return { refused: `${problems.join("\n")}\nnothing written` };
  for (const { source_id: _, ...c } of fresh) await d.store.addSkillEvalCase(c);
  return { value: { source: name, added: fresh.map((c) => c.id), kept } };
}
