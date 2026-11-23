// `/paths +<path>...` and `factory task paths` (design 05-interactive-sessions): the owner widens a running item's allowed
// paths in place. The commands unit runs it as a gate command (owner check, egress scan, `widen`), with these two steps.

import { type Actor, type CommandEvent, type Decision, type Refusal, type Widening, type WorkItem, commandPhase, phaseLabel } from "../support.js";

type PathsEvent = Extract<CommandEvent, { kind: "paths_requested" }>;

/**
 * A command's text as commandNote reads it: `/paths +a +b` as `+paths a b` (so parseCommandPaths' rules hold: at most
 * 10, no empty, absolute, `..` or glob path), the note on the lines below; the text of an `/approve`, `/retry` or
 * `/resolve` as it is; null for a command that takes no note or paths. A `/paths`
 * with no path, or a first-line word without its `+` (so `-<path>` too: no form removes a path), is refused quoting
 * nothing, since the text is not scanned yet.
 */
export function commandText(e: CommandEvent): string | undefined | null | Refusal {
  if (e.kind !== "paths_requested") return e.kind === "resolve_requested" ? e.notes : e.kind === "spec_approved" || e.kind === "retry_requested" ? e.note : null;
  const [first = "", ...rest] = (e.note ?? "").trim().split(/\r?\n/);
  const words = first.trim().split(/\s+/).filter((w) => w !== "");
  if (words.length === 0) return { refuse: "`/paths` needs at least one path with `+` before it, e.g. `/paths +src/x.ts`" };
  if (words.some((w) => !w.startsWith("+"))) return { refuse: "each path after `/paths` starts with `+`, e.g. `/paths +src/x.ts +tests/x.test.ts`; a note goes on the lines below" };
  return [`+paths ${words.map((w) => w.slice(1)).join(" ")}`, ...rest].join("\n");
}

/**
 * The `/paths` transition: on a RUNNING item, one `paths_requested` state change with the owner as actor, the widened
 * allowed_paths (and a tier raised by a floor, as `widen` does) and `comment_id`, `added_paths` and the note in its detail.
 * No run is queued or stopped: an interactive session's finish and a worker's next implement attempt read the item from
 * the store. Any other stage is refused. No new path (every one already covered): nothing changes, and the commands
 * unit's "already allowed" reply says so.
 */
export function pathsCommand(e: PathsEvent, it: WorkItem, actor: Actor, note: string | null, w: Widening): Decision | Refusal {
  if (it.stage !== "RUNNING") {
    return { refuse: `the item is ${phaseLabel(commandPhase(it))}; \`/paths\` applies only while the item is being implemented (an interactive session or a worker implement run)` };
  }
  if (w.patch.allowed_paths === undefined) return null;
  return { patch: w.patch, actor, reason: "paths_requested", detail: { comment_id: e.comment_id, ...w.detail, ...(note ? { note } : {}) } };
}
