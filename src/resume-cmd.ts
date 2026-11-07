// `factory resume [name | --all]` (design §5 Restarts, issue #291): ends a claim pause now instead of waiting
// for its time. The dashboard's "Resume now" button (src/ui/pause-api.ts) ends one through endPause below, so
// both write the same log line. Every end is a conditional store write (FactoryStore.endClaimPause): a second
// resume, or one with no pause in effect, changes nothing.

import type { Logger } from "./core/log.js";
import type { FactoryStore } from "./interfaces/factory-store.js";

/** The claim pauses an owner may end. `model_stall_since` and `model_answered` are parts of `model_stall`. */
export const RESUMABLE_PAUSES = ["rate_limit", "forge_auth", "preflight_access", "model_stall"] as const;
export type ResumablePause = (typeof RESUMABLE_PAUSES)[number];

export const RESUME_USAGE = `usage: factory resume [name | --all]
  no name: rate_limit; name: one of ${RESUMABLE_PAUSES.join(", ")}; --all: every one of them`;

export function isResumablePause(name: unknown): name is ResumablePause {
  return typeof name === "string" && (RESUMABLE_PAUSES as readonly string[]).includes(name);
}

/** The pauses to end, or an error for anything else (an unknown name, a second argument). */
export function parseResumeArgs(args: readonly string[]): { pauses: ResumablePause[] } | { error: string } {
  if (args.length === 0) return { pauses: ["rate_limit"] };
  if (args.length > 1) return { error: `factory resume takes one name or --all, got ${args.length} arguments` };
  const [arg] = args;
  if (arg === "--all") return { pauses: [...RESUMABLE_PAUSES] };
  if (isResumablePause(arg)) return { pauses: [arg] };
  return { error: `unknown pause ${JSON.stringify(arg)}; known: ${RESUMABLE_PAUSES.join(", ")}` };
}

export interface ResumeDeps {
  store: Pick<FactoryStore, "endClaimPause">;
  /** Who resumes, as an ID (`local:<login>` on the CLI, the factory user ID in the UI), never a display name. */
  actor: string;
  log: Logger;
}

/** Ends one pause and writes one log line with the actor ID. `ended` is false when none was in effect. */
export async function endPause(d: ResumeDeps, pause: ResumablePause): Promise<{ ended: boolean }> {
  const r = await d.store.endClaimPause(pause);
  d.log.info(r.ended ? "claim pause ended" : "claim pause resume: none in effect", { pause, actor: d.actor, ended: r.ended });
  return r;
}

/** `factory resume`: one line per pause, what it ended or "no pause in effect". Always exit 0. */
export async function runResume(d: ResumeDeps, a: { pauses: readonly ResumablePause[] }): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  for (const pause of a.pauses) {
    const r = await endPause(d, pause);
    lines.push(r.ended ? `ended the ${pause} pause` : `${pause}: no pause in effect`);
  }
  return { code: 0, lines };
}
