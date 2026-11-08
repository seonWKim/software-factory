// Runs the enabled hooks of one point (RFC 0015 §8, §15.2). The guards decide first: when they refused, no hook
// runs and nothing a hook says can change that. Each hook runs within its budget; a hook that runs over or throws
// counts as a veto (fail closed). Every decision is audited. No hook is enabled by default, solo or enterprise.

import type { HookDescriptor, HookInput, HookPoint, Timer } from "../../shared/hook.js";
import type { Located } from "../registry/registry.js";
import { loadDescriptors } from "../registry/registry.js";
import { CODE_ROOT } from "../settings/catalog.js";

export type HookOutcomeKind = "pass" | "veto" | "annotate" | "timeout" | "error";

export interface HookDecision {
  readonly hook: string;
  readonly point: HookPoint;
  readonly subject: string;
  readonly project_id: string;
  readonly passport_id: string | null;
  readonly outcome: HookOutcomeKind;
  /** The veto reason or the note, at most TEXT_MAX characters; null on a pass. */
  readonly text: string | null;
  readonly at: string;
}

export interface HookAudit {
  record(decisions: readonly HookDecision[]): Promise<void>;
}

export interface HookResult {
  readonly allowed: boolean;
  /** Why it is refused: the guard's reason, or the first veto (`hook <name>: <reason>`); null when allowed. */
  readonly reason: string | null;
  readonly notes: readonly { hook: string; note: string }[];
  readonly decisions: readonly HookDecision[];
}

export const TEXT_MAX = 200;
const clip = (t: string) => (t.length > TEXT_MAX ? `${t.slice(0, TEXT_MAX - 1)}…` : t);

export async function runHooks(o: {
  input: HookInput;
  hooks: readonly HookDescriptor[];
  /** Hook names the owner enabled for this project. */
  enabled: ReadonlySet<string>;
  /** What the guards decided before any hook runs. */
  guard: { allowed: true } | { allowed: false; reason: string };
  timer: Timer;
  audit?: HookAudit;
}): Promise<HookResult> {
  if (!o.guard.allowed) return { allowed: false, reason: o.guard.reason, notes: [], decisions: [] };
  const due = o.hooks.filter((h) => h.point === o.input.point && o.enabled.has(h.name)).sort((a, b) => a.name.localeCompare(b.name));
  const decisions: HookDecision[] = [];
  for (const h of due) {
    const [outcome, text] = await runOne(h, o.input, o.timer);
    decisions.push({ hook: h.name, point: h.point, subject: o.input.subject, project_id: o.input.project_id, passport_id: o.input.passport_id, outcome, text, at: o.input.at });
  }
  if (decisions.length > 0) await o.audit?.record(decisions);
  const refused = decisions.find((d) => d.outcome === "veto" || d.outcome === "timeout" || d.outcome === "error");
  return {
    allowed: refused === undefined,
    reason: refused ? `hook ${refused.hook}: ${refused.text}` : null,
    notes: decisions.filter((d) => d.outcome === "annotate").map((d) => ({ hook: d.hook, note: d.text! })),
    decisions,
  };
}

async function runOne(h: HookDescriptor, input: HookInput, timer: Timer): Promise<[HookOutcomeKind, string | null]> {
  const ac = new AbortController();
  const late = timer.after(h.budget_ms, ac.signal).then(() => "timeout" as const);
  try {
    const v = await Promise.race([h.run(input, ac.signal), late]);
    if (v === "timeout") return ["timeout", `hook_timeout: over its ${h.budget_ms} ms budget`];
    if (v.kind === "veto") return ["veto", clip(v.reason)];
    if (v.kind === "annotate") return ["annotate", clip(v.note)];
    return ["pass", null];
  } catch (err) {
    return ["error", clip(`hook_error: ${err instanceof Error ? err.message : String(err)}`)];
  } finally {
    ac.abort();
  }
}

let cached: Promise<Located<HookDescriptor>[]> | null = null;

/** Every `*.hook.ts` under `root` (cached for the code root). */
export function loadHooks(root: string = CODE_ROOT): Promise<Located<HookDescriptor>[]> {
  if (root === CODE_ROOT && cached) return cached;
  const load = loadDescriptors<HookDescriptor>(root, "hook");
  if (root === CODE_ROOT) cached = load;
  return load;
}

/** The convention path of a hook: `<component>/hooks/<name>/<name>.hook.ts` under the code root. */
export const HOOK_PATH = /^([a-z]+)\/hooks\/([a-z0-9-]+)\/([a-z0-9-]+)\.hook\.(?:ts|js)$/;
