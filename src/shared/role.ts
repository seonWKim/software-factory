// Roles (run kinds) as an extension point (RFC 0015 §8, #305): each role is one `src/worker/roles/<name>.role.ts`,
// found by discovery, declaring its prompt, its tools, its Rule of Two profile, what it proposes and approves, and
// its golden cases. The role folder is on the gate list, so a change to a role's facts needs the owner's merge.
// Pure: no I/O.

/**
 * The Rule of Two facts (RFC 0015 §8; Meta's "Agents Rule of Two"). Classification starts strict.
 * - untrusted_input: text from outside the trust set, or web content. An approved spec is trusted, but text it
 *   quotes from outside the trust set is not.
 * - sensitive_access: secrets, private repositories, production data.
 * - external_effect: anything the run itself sends out, push included. Output the factory posts later through
 *   outbound (G5-scanned, decided by the controller) is not the run's own effect.
 */
export interface RuleOfTwo {
  readonly untrusted_input: boolean;
  readonly sensitive_access: boolean;
  readonly external_effect: boolean;
}

export const RULE_OF_TWO_FACTS = ["untrusted_input", "sensitive_access", "external_effect"] as const satisfies readonly (keyof RuleOfTwo)[];

/** What a run produces or passes judgement on. A role never approves what it proposes (`rule-of-two`). */
export type Artifact = "spec" | "change" | "verdict";

export interface RoleDescriptor {
  readonly kind: "role";
  /** The run kind (`implement`); the file is `src/worker/roles/<name>.role.ts`. */
  readonly name: string;
  /** Its system prompt under prompts/, or null for a role that calls no model. */
  readonly prompt: string | null;
  /** Tool names the run gets; a role never grants itself more (the run passport narrows to these). */
  readonly tools: readonly string[];
  /** True when it starts and acts with no person approving its input or its effects (in manual mode). */
  readonly autonomous: boolean;
  readonly rule_of_two: RuleOfTwo;
  readonly proposes: readonly Artifact[];
  readonly approves: readonly Artifact[];
  /** Golden cases it ships with (golden/cases/, by `role` in case.json); a role or prompt change replays them. */
  readonly golden: { readonly min_cases: number };
}

export const ROLE_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Whether `r` holds all three facts: untrusted input, sensitive access and an external effect. */
export const holdsAllFacts = (r: RuleOfTwo) => RULE_OF_TWO_FACTS.every((f) => r[f]);

/** Why the role breaks the Rule of Two or its own shape, or []. */
export function roleProblems(r: Omit<RoleDescriptor, "kind">): string[] {
  const out: string[] = [];
  if (!ROLE_NAME.test(r.name)) out.push(`role name "${r.name}" must be kebab-case`);
  for (const f of RULE_OF_TWO_FACTS) if (typeof r.rule_of_two?.[f] !== "boolean") out.push(`${r.name}: rule_of_two.${f} must be declared`);
  if (r.autonomous && r.rule_of_two && holdsAllFacts(r.rule_of_two)) {
    out.push(`${r.name}: an autonomous role holds untrusted input, sensitive access and an external effect; drop one or put a person before it`);
  }
  for (const a of r.approves) if (r.proposes.includes(a)) out.push(`${r.name}: proposes and approves ${a}`);
  if (!Number.isInteger(r.golden.min_cases) || r.golden.min_cases < 1) out.push(`${r.name}: ships with at least one golden case`);
  return out;
}

export function defineRole(r: Omit<RoleDescriptor, "kind">): RoleDescriptor {
  const problems = roleProblems(r);
  if (problems.length > 0) throw new Error(problems.join("; "));
  return { kind: "role", ...r };
}

/**
 * Why `role` may not run now, or null. A role that holds all three facts runs only after a person approved its
 * input (a spec approved by a person, a `/resolve` by a person); an approval by the factory itself (auto mode)
 * does not count.
 */
export function ruleOfTwoRefusal(role: RoleDescriptor, ctx: { person_approved: boolean }): string | null {
  if (!holdsAllFacts(role.rule_of_two) || ctx.person_approved) return null;
  return `rule_of_two: ${role.name} holds untrusted input, sensitive access and an external effect; a person must approve before it runs`;
}

/** Who did something: the role (run kind, or `person`) and the principal (user id or run passport principal). */
export interface Actor {
  readonly role: string;
  readonly principal: string;
}

/**
 * Why `approver` may not approve `artifact` that `proposer` proposed, or null. Never the proposing role, never the
 * same principal, and a role only approves what it declares in `approves`. A person (`role: "person"`) approves
 * by their grants, which identity checks; here only "not the proposer" applies.
 */
export function approvalRefusal(artifact: Artifact, proposer: Actor, approver: Actor, roles: (name: string) => RoleDescriptor | null): string | null {
  if (approver.principal === proposer.principal) return `${approver.principal} proposed this ${artifact} and may not approve it`;
  if (approver.role === "person") return null;
  if (approver.role === proposer.role) return `role ${approver.role} proposed this ${artifact} and may not approve it`;
  const r = roles(approver.role);
  if (!r) return `role ${approver.role} is not declared`;
  if (!r.approves.includes(artifact)) return `role ${approver.role} does not approve a ${artifact}`;
  return null;
}
