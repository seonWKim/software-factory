// Mirrors CLI commands to their item's issue. A pure step (RFC 0015 §6.2): it loads the unmirrored commands, their
// items and their mirror's delivery, and decides the thread entries and marks the router commits.

import { LOCAL_SOURCE } from "../../../core/local-merge.js";
import { type WorkItem, type WorkItemId } from "../../../core/types.js";
import type { CliCommand } from "../../../interfaces/factory-store.js";
import { QUOTABLE_COMMAND } from "../support.js";
import type { ControllerReader } from "../kernel.js";
import type { ControllerDecision } from "../context.js";
import { controllerUnit } from "../context.js";

/** CLI commands mirrored to their issue per tick at most (design 05-sources, CLI intake). */
const MIRROR_BATCH = 50;

/** One unmirrored command as loaded: its item (null: none, or nothing to post), and its mirror's state. */
interface Pending {
  readonly c: CliCommand;
  readonly item: WorkItem | null;
  readonly marker: string;
  /** The mirror's outbox row: absent (not written yet), written, or delivered. */
  readonly mirror: "absent" | "pending" | "delivered";
  /** The comment to write, when it is not written yet. */
  readonly body: string | null;
}

/** Mirrors CLI commands to their item's issue. */
export class MirrorUnit {
  /** The unmirrored commands, each with its item and its mirror's delivery. */
  async load(r: ControllerReader): Promise<Pending[]> {
    const out: Pending[] = [];
    for (const c of await r.listUnmirroredCliCommands(MIRROR_BATCH)) {
      const marker = `<!-- factory:cli:${c.key} -->`;
      const id = c.args.item;
      const found = typeof id === "string" && id !== "" ? await r.getWorkItem(id as WorkItemId) : null;
      // No item, or a local one: nothing to post anywhere.
      const item = found && found.source.type !== LOCAL_SOURCE ? found : null;
      const row = item ? (await r.listDeliveries(item.id)).find((d) => d.marker === marker) : undefined;
      const mirror = !row ? "absent" : row.delivered_at ? "delivered" : "pending";
      out.push({ c, item, marker, mirror, body: item && mirror === "absent" ? await mirrorBody(r, c) : null });
    }
    return out;
  }

  /**
   * The CLI mirror (design 05-sources, CLI intake): each CLI command on an item of a sync source (appended with
   * `mirror`) is written once to its item's thread, keyed `cli:<command key>`, so the outbox posts it on the issue
   * once, with its retries and backoff. The command is marked mirrored only when that post was delivered, so a
   * failed or rate-limited post leaves it for a later tick. Best effort: it never touches the item's state, and the
   * transition the command gives never waits on it. Safe on any replica and safe to run twice.
   */
  decide(pending: readonly Pending[]): ControllerDecision {
    const writes: ControllerDecision["writes"][number][] = [];
    for (const p of pending) {
      if (!p.item || p.mirror === "delivered") writes.push({ kind: "cli_mirrored", key: p.c.key });
      else if (p.body !== null) {
        const { item } = p;
        const delivery = { source_type: item.source.type, target: item.source, link_field: null };
        writes.push({ kind: "thread_entry", entry: { work_item_id: item.id, marker: p.marker, body: p.body, delivery } });
      }
    }
    return { writes };
  }
}

/**
 * A CLI command as a comment on its issue: who sent which command, and its note quoted, egress-scanned first (a
 * flagged note is left out). It never starts with `/`, so the source poll reads it as a plain comment.
 */
async function mirrorBody(r: ControllerReader, c: CliCommand): Promise<string> {
  const name = QUOTABLE_COMMAND.test(c.command) ? `\`/${c.command}\`` : "A command";
  const head = `${name} was sent from the factory CLI by \`${c.actor}\` (command \`${c.key}\`).`;
  const text = typeof c.args.text === "string" ? c.args.text.trim() : "";
  if (text === "") return head;
  if (!(await r.scan("comment", text)).clean) return `${head}\n\nIts note is not shown: the leak scanner flagged it.`;
  return `${head}\n\n${text.split(/\r?\n/).map((l) => `> ${l}`).join("\n")}`;
}

declare module "../../router/unit.js" {
  interface UnitOperations {
    "mirror": MirrorUnit;
  }
}

export default controllerUnit({
  name: "mirror",
  create: () => new MirrorUnit(),
  steps: [
    {
      name: "cli mirror", every: "tick", order: 80,
      load: (u, r) => u.load(r),
      decide: (u, pending: Pending[]) => u.decide(pending),
    },
  ],
});
