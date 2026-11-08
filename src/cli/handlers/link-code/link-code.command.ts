import { buildStatsStore } from "../../../compose.js";
import { linkCodeCommand } from "../../../impl/auth/link-code.js";
import { defineCommand } from "../../command.js";

export default defineCommand({
  names: ["link-code"],
  usage: `  link-code <user_id>
               prints a one-time code that links another account (e.g. Slack) to a factory user such as
               github:12345: post /link <code> from that account. Works once, for 10 minutes`,
  async run(args, ctx) {
    // Only the code's hash is stored; the code is printed here once and nowhere else (design 2026-11-01).
    const store = await buildStatsStore(await ctx.load());
    try {
      await store.migrate();
      console.log(await linkCodeCommand(store, [...args]));
    } finally {
      await store.close();
    }
    return 0;
  },
});
