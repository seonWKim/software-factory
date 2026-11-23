// `factory attach <id> <file>` and `factory attach <id> --link <url> [label]` (design 02-attachments): one image (png,
// jpeg, gif or webp, up to 5 MB) or one http or https link on a New or in-triage item, stored in the controller store
// through core/attachments.ts `runAttach` and `attach`, the same path and refusals as the dashboard's Attach dialog.
// The owner check runs first; nothing is written into the repository or a sandbox. The next triage run reads it.

import { randomUUID } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { MAX_IMAGE_BYTES, parseAttachArgs, runAttach } from "../../../core/attachments.js";
import { Plugins, defineCommand, localAuth } from "../../command.js";

/** The file's size, and its bytes up to the image limit plus one (only the first 16 past it). */
async function readHead(path: string): Promise<{ size: number; bytes: Uint8Array }> {
  const { size } = await stat(path);
  const h = await open(path, "r");
  try {
    const want = size > MAX_IMAGE_BYTES ? 16 : size;
    const buf = new Uint8Array(want);
    const { bytesRead } = await h.read(buf, 0, want, 0);
    return { size, bytes: buf.subarray(0, bytesRead) };
  } finally {
    await h.close();
  }
}

export default defineCommand({
  names: ["attach"],
  usage: `  attach <id> <file>
               attaches a png, jpeg, gif or webp image (up to 5 MB) to a New or in-triage item; the next triage
               run gets it as image input. Any other type, a larger file or another stage is refused
  attach <id> --link <url> [label]
               attaches an http or https link with an optional label; it passes the egress scan first`,
  async run(args, ctx) {
    const a = parseAttachArgs(args);
    if ("error" in a) {
      console.error(a.error);
      return 1;
    }
    const { user } = await ctx.identity();
    return ctx.withStore(async (store, loaded) => {
      const p = new Plugins(loaded);
      const r = await runAttach({
        store, user, auth: await localAuth(loaded, store), scanner: await p.scanner(await p.secrets()), newId: () => randomUUID(), read: readHead, env: process.env,
      }, a);
      for (const line of r.lines) (r.code === 0 ? console.log : console.error)(line);
      return r.code;
    });
  },
});
