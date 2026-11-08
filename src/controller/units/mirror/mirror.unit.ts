// Mirrors CLI commands to their item's issue.
// Moved out of the legacy controller (RFC 0015 M5); its I/O is still inline (unit-purity ratchet).

import { LOCAL_SOURCE } from "../../../core/local-merge.js";
import { type WorkItemId } from "../../../core/types.js";
import type { CliCommand } from "../../../interfaces/factory-store.js";
import { QUOTABLE_COMMAND } from "../support.js";
import type { Ctx } from "../context.js";
import { controllerUnit } from "../context.js";

/** CLI commands mirrored to their issue per tick at most (design 05-sources, CLI intake). */
const MIRROR_BATCH = 50;

/** Mirrors CLI commands to their item's issue. */
export class MirrorUnit {
  constructor(private readonly c: Ctx) {}

  /**
   * The CLI mirror (design 05-sources, CLI intake): each CLI command on an item of a sync source (appended with
   * `mirror`) is written once to its item's thread, keyed `cli:<command key>`, so the outbox posts it on the issue
   * once, with its retries and backoff. The command is marked mirrored only when that post was delivered, so a
   * failed or rate-limited post leaves it for a later tick. Best effort: it never touches the item's state, and the
   * transition the command gives never waits on it. Safe on any replica and safe to run twice.
   */
  async mirrorStep(): Promise<void> {
    for (const c of await this.c.k.d.store.listUnmirroredCliCommands(MIRROR_BATCH)) {
      const id = c.args.item;
      const item = typeof id === "string" && id !== "" ? await this.c.k.d.store.getWorkItem(id as WorkItemId) : null;
      // No item, or a local one: nothing to post anywhere.
      if (!item || item.source.type === LOCAL_SOURCE) {
        await this.c.k.d.store.markCliCommandMirrored(c.key);
        continue;
      }
      const marker = `<!-- factory:cli:${c.key} -->`;
      await this.c.unit("outbox").post(item, item.source, await this.mirrorBody(c), marker);
      const row = (await this.c.k.d.store.listDeliveries(item.id)).find((d) => d.marker === marker);
      if (row?.delivered_at) await this.c.k.d.store.markCliCommandMirrored(c.key);
    }
  }

  /**
   * A CLI command as a comment on its issue: who sent which command, and its note quoted, egress-scanned first (a
   * flagged note is left out). It never starts with `/`, so the source poll reads it as a plain comment.
   */
  async mirrorBody(c: CliCommand): Promise<string> {
    const name = QUOTABLE_COMMAND.test(c.command) ? `\`/${c.command}\`` : "A command";
    const head = `${name} was sent from the factory CLI by \`${c.actor}\` (command \`${c.key}\`).`;
    const text = typeof c.args.text === "string" ? c.args.text.trim() : "";
    if (text === "") return head;
    if (!(await this.c.k.d.scanner.scan("comment", text)).clean) return `${head}\n\nIts note is not shown: the leak scanner flagged it.`;
    return `${head}\n\n${text.split(/\r?\n/).map((l) => `> ${l}`).join("\n")}`;
  }
}

declare module "../../router/unit.js" {
  interface UnitOperations {
    "mirror": MirrorUnit;
  }
}

export default controllerUnit({
  name: "mirror",
  create: (c: Ctx) => new MirrorUnit(c),
  steps: [
    { name: "cli mirror", every: "tick", order: 80, run: (u) => u.mirrorStep() },
  ],
});
