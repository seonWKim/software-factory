// `factory resume [name | --all]` (design §5 Restarts, issue #291) and `factory stop` (design 05-restart-pauses,
// 2026-11-21): ends a claim pause, or the owner pause, now instead of waiting for its time. The dashboard's "Resume
// now" button (src/ui/pause-api.ts) ends one through endPause below and its "Stop all agents" (src/ui/agents-api.ts)
// starts the owner pause through stopAgents, so the CLI and the page write the same log line. Every write is a
// conditional store write: a second resume, or one with no pause in effect, changes nothing; a second stop keeps the
// first one's row.
//
// The owner pause is the all-workers row of `worker_pauses` (`workers pause --all`, design §5 Pause), not a pause of
// its own: while it holds no worker claims, and each worker stops its implement and review runs within one tick_ms,
// putting them back in the queue with their attempt, folder and commits kept. Ending it clears every worker pause, as
// `workers resume` does.

import type { Logger } from "./core/log.js";
import type { Timestamp } from "./core/types.js";
import type { FactoryStore } from "./interfaces/factory-store.js";

/** The claim pauses an owner may end. `model_stall_since` and `model_answered` are parts of `model_stall`. */
export const RESUMABLE_PAUSES = ["rate_limit", "forge_auth", "preflight_access", "model_stall"] as const;
export type ClaimResumable = (typeof RESUMABLE_PAUSES)[number];

/** `factory stop`'s pause: every worker loop paused by the owner (the `*` row of worker_pauses). */
export const OWNER_PAUSE = "owner";
export type ResumablePause = ClaimResumable | typeof OWNER_PAUSE;

/** Every name `factory resume` takes, in the order `--all` ends them. */
export const RESUME_NAMES: readonly ResumablePause[] = [...RESUMABLE_PAUSES, OWNER_PAUSE];

export const RESUME_USAGE = `usage: factory resume [name | --all]
  no name: rate_limit; name: one of ${RESUME_NAMES.join(", ")}; --all: every one of them`;

export function isResumablePause(name: unknown): name is ResumablePause {
  return typeof name === "string" && (RESUME_NAMES as readonly string[]).includes(name);
}

/** The pauses to end, or an error for anything else (an unknown name, a second argument). */
export function parseResumeArgs(args: readonly string[]): { pauses: ResumablePause[] } | { error: string } {
  if (args.length === 0) return { pauses: ["rate_limit"] };
  if (args.length > 1) return { error: `factory resume takes one name or --all, got ${args.length} arguments` };
  const [arg] = args;
  if (arg === "--all") return { pauses: [...RESUME_NAMES] };
  if (isResumablePause(arg)) return { pauses: [arg] };
  return { error: `unknown pause ${JSON.stringify(arg)}; known: ${RESUME_NAMES.join(", ")}` };
}

export interface ResumeDeps {
  store: Pick<FactoryStore, "endClaimPause" | "resumeWorkers">;
  /** Who resumes, as an ID (the CLI identity's user on the CLI, the factory user ID in the UI), never a display name. */
  actor: string;
  log: Logger;
}

/** Ends one pause and writes one log line with the actor ID. `ended` is false when none was in effect. */
export async function endPause(d: ResumeDeps, pause: ResumablePause): Promise<{ ended: boolean }> {
  const r = pause === OWNER_PAUSE ? { ended: (await d.store.resumeWorkers()).cleared > 0 } : await d.store.endClaimPause(pause);
  d.log.info(r.ended ? "claim pause ended" : "claim pause resume: none in effect", { pause, actor: d.actor, ended: r.ended });
  return r;
}

/**
 * `factory resume`: the owner check first (approve_spec, as the dashboard's "Resume now"); a refusal is one line, exit 1,
 * and ends nothing. Else one line per pause, what it ended or "no pause in effect", exit 0.
 */
export async function runResume(
  d: ResumeDeps & { refusal: () => Promise<string | null> }, a: { pauses: readonly ResumablePause[] },
): Promise<{ code: number; lines: string[] }> {
  const refused = await d.refusal();
  if (refused !== null) return { code: 1, lines: [`not resumed: ${refused}`] };
  const lines: string[] = [];
  for (const pause of a.pauses) {
    const r = await endPause(d, pause);
    lines.push(r.ended ? `ended the ${pause} pause` : `${pause}: no pause in effect`);
  }
  return { code: 0, lines };
}

/** The owner pause in effect: who stopped the agents and when, or null. */
export async function ownerPause(store: Pick<FactoryStore, "listWorkerPauses">): Promise<{ by: string; since: Timestamp } | null> {
  const row = (await store.listWorkerPauses()).find((p) => p.worker_id === "*");
  return row ? { by: row.paused_by, since: row.paused_at } : null;
}

export interface StopDeps {
  store: Pick<FactoryStore, "pauseWorkers" | "listWorkerPauses">;
  /** Who stops, as an ID, never a display name; kept in the pause row. */
  actor: string;
  log: Logger;
}

/**
 * Starts the owner pause and writes one log line with the actor ID (the logger adds the time). `stopped` is false when
 * it was already in effect: the first stop's row, its actor and time, stays.
 */
export async function stopAgents(d: StopDeps): Promise<{ stopped: boolean; since: Timestamp | null }> {
  const { paused } = await d.store.pauseWorkers({ all: true }, d.actor);
  const since = (await ownerPause(d.store))?.since ?? null;
  const stopped = paused.length > 0;
  d.log.info(stopped ? "agents stopped" : "agents stop: already stopped", { pause: OWNER_PAUSE, actor: d.actor, stopped, since });
  return { stopped, since };
}

/** `factory stop`: the owner check first; a refusal is one line, exit 1, and writes nothing. */
export async function runStop(d: StopDeps & { refusal: () => Promise<string | null> }): Promise<{ code: number; lines: string[] }> {
  const refused = await d.refusal();
  if (refused !== null) return { code: 1, lines: [`not changed: ${refused}`] };
  const r = await stopAgents(d);
  return {
    code: 0,
    lines: [
      r.stopped ? `stopped every agent at ${r.since}` : `agents were already stopped at ${r.since}`,
      "no worker claims a run; implement and review runs go back to the queue within one tick, their work kept; other runs finish first. Undo with: factory resume owner",
    ],
  };
}
