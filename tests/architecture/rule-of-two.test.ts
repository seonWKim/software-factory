import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { isGatePath } from "../../src/core/improver.js";
import { MODEL_RUN_KINDS } from "../../src/core/model-choice.js";
import { READ_TOOLS, WRITE_TOOLS } from "../../src/core/worker.js";
import { type RoleCatalog, loadRoles, rolesShortOfGolden } from "../../src/runtime/index.js";
import { type RoleDescriptor, approvalRefusal, defineRole, roleProblems, ruleOfTwoRefusal } from "../../src/shared/role.js";
import { REPO, ratchet } from "./lib.js";

// RFC 0015 §8, §9 rule-of-two: every role declares its three facts; no autonomous role holds all three; no role
// approves what it proposes, and no principal approves its own proposal; role files sit on the gate list, so
// their facts change only by an owner merge; each role ships its golden cases (ratchet: today's shortfalls).

let roles: RoleCatalog;
beforeAll(async () => {
  roles = await loadRoles();
});

const BASE: Omit<RoleDescriptor, "kind"> = {
  name: "x",
  prompt: null,
  tools: [],
  autonomous: true,
  rule_of_two: { untrusted_input: true, sensitive_access: true, external_effect: false },
  proposes: ["change"],
  approves: [],
  golden: { min_cases: 1 },
};

describe("rule-of-two", () => {
  it("every role is well formed, at src/worker/roles/<name>.role.ts, on the gate list", () => {
    const bad: string[] = [];
    for (const { file, descriptor: r } of roles.entries) {
      bad.push(...roleProblems(r));
      if (file !== join("worker", "roles", `${r.name}.role.ts`)) bad.push(`${file}: expected src/worker/roles/${r.name}.role.ts`);
      if (!isGatePath(`src/${file}`)) bad.push(`src/${file}: not on the gate list (PROTECTED_PATHS.permissions)`);
      if (r.prompt !== null && !existsSync(join(REPO, "prompts", r.prompt))) bad.push(`${r.name}: prompts/${r.prompt} does not exist`);
    }
    expect(bad).toEqual([]);
  });

  it("covers every agent run kind with the tools the worker gives it", () => {
    expect(roles.all().map((r) => r.name)).toEqual([...MODEL_RUN_KINDS].sort());
    const names = (t: readonly { name: string }[]) => t.map((x) => x.name);
    for (const r of roles.all()) expect(r.tools, r.name).toEqual(names(r.name === "triage" ? READ_TOOLS : WRITE_TOOLS));
  });

  it("refuses an autonomous role with all three facts, a missing fact, and a role that approves what it proposes", () => {
    expect(() => defineRole({ ...BASE, rule_of_two: { untrusted_input: true, sensitive_access: true, external_effect: true } })).toThrow(/autonomous role holds/);
    expect(() => defineRole({ ...BASE, autonomous: false, rule_of_two: { untrusted_input: true, sensitive_access: true, external_effect: true } })).not.toThrow();
    expect(() => defineRole({ ...BASE, rule_of_two: { untrusted_input: true, sensitive_access: true } as never })).toThrow(/external_effect must be declared/);
    expect(() => defineRole({ ...BASE, approves: ["change"] })).toThrow(/proposes and approves change/);
    expect(() => defineRole({ ...BASE, golden: { min_cases: 0 } })).toThrow(/golden case/);
  });

  it("a role with all three facts runs only after a person approved its input", () => {
    const holding = roles.all().filter((r) => r.rule_of_two.untrusted_input && r.rule_of_two.sensitive_access && r.rule_of_two.external_effect);
    expect(holding.map((r) => r.name).sort()).toEqual(["implement", "resolve"]);
    for (const r of holding) {
      expect(r.autonomous, r.name).toBe(false);
      expect(ruleOfTwoRefusal(r, { person_approved: false }), r.name).toMatch(/^rule_of_two:/);
      expect(ruleOfTwoRefusal(r, { person_approved: true }), r.name).toBeNull();
    }
    expect(ruleOfTwoRefusal(roles.get("review")!, { person_approved: false })).toBeNull();
  });

  it("no role approves what it proposes, and no principal approves its own proposal", () => {
    const get = (n: string) => roles.get(n);
    const implement = { role: "implement", principal: "run:r1" };
    expect(approvalRefusal("change", implement, { role: "review", principal: "run:r2" }, get)).toBeNull();
    expect(approvalRefusal("change", implement, { role: "implement", principal: "run:r3" }, get)).toMatch(/proposed this change/);
    expect(approvalRefusal("change", implement, { role: "review", principal: "run:r1" }, get)).toMatch(/proposed this change/);
    expect(approvalRefusal("change", implement, { role: "triage", principal: "run:r4" }, get)).toMatch(/does not approve a change/);
    expect(approvalRefusal("spec", { role: "triage", principal: "run:r5" }, { role: "person", principal: "local:owner" }, get)).toBeNull();
    for (const r of roles.all()) for (const a of r.approves) expect(r.proposes, r.name).not.toContain(a);
  });

  it("each role ships its golden cases (ratchet)", () => {
    const short = rolesShortOfGolden(roles, join(REPO, "golden", "cases"));
    ratchet("rule-of-two", short.map((s) => `golden-cases-missing|worker/roles/${s.role}.role.ts|${s.role}`));
  });
});
