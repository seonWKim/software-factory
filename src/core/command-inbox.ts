import { commentEvent } from "./comment-event.js";
import type { SourceRef } from "./types.js";
import { localIdentity } from "./local-cli.js";
import type { CliCommand } from "../interfaces/factory-store.js";
import type { SourceEvent } from "../interfaces/source-adapter.js";

/**
 * The command inbox's reader (issue #282; design 05-sources "Thread first"). A CLI command (`args.item` the work
 * item ID, `args.text` an optional string) is rebuilt as `/<command> <text>` and mapped by the one comment event
 * mapping (src/core/comment-event.ts) GitHub-free sources share, so the controller handles it as the same comment:
 * the same event kinds, the same authorize check, the same replies. `comment_id` is the command's key; the
 * identity is provider `local`, subject the actor after `local:`.
 */
export function commandEvent(c: CliCommand, source: SourceRef): SourceEvent | null {
  const text = typeof c.args.text === "string" ? c.args.text : "";
  return commentEvent(source, c.key, localIdentity(c.actor), text === "" ? `/${c.command}` : `/${c.command} ${text}`);
}
