import { Plugins, build } from "../../../compose.js";
import type { WorkItemId } from "../../../core/types.js";
import { modelStallLine } from "../../../ui/factory-status.js";
import { defineCommand } from "../../command.js";
import { statusLines } from "./lines.js";

export default defineCommand({
  names: ["status"],
  usage: `  status [id] [--raw|--json]  one line per work item (short ID, title, state, what needs you); --raw the table, --json the list as JSON; an ID: its state_changes trail`,
  async run(args, ctx) {
    const app = await build(await ctx.load());
    const flag = args.find((a) => a.startsWith("--"));
    const [target] = args.filter((a) => !a.startsWith("--"));
    if (target) {
      const id = target as WorkItemId;
      console.log(JSON.stringify({ item: await app.store.getWorkItem(id), runs: await app.store.listRuns(id), state_changes: await app.store.listStateChanges(id) }, null, 2));
    } else {
      // While a stall pause is in effect (design §5 Restarts), say so above the table.
      const stall = await modelStallLine(app.store);
      if (stall) console.log(stall);
      const items = await app.store.listWorkItems(50);
      const fields = items.map(({ id, source, stage, blocked_on, blocked_reason, tier, loop_count, change_ref, version }) =>
        ({ id, source: source.id, stage, blocked_on, blocked_reason, tier, loop_count, change_ref, version }));
      if (flag === "--json") console.log(JSON.stringify(fields, null, 2));
      else if (flag === "--raw") console.table(fields);
      else {
        // Loaded only here: the other forms of status need none of the dashboard's list code.
        const [{ NO_FILTERS }, { listRows }, { Withholder }] = await Promise.all([import("../../../ui/filters.js"), import("../../../ui/list.js"), import("../../../ui/withhold.js")]);
        // The dashboard's own ranked rows (listRows), so the state words match its list.
        const ctx = { store: app.store, w: new Withholder(await new Plugins(app.loaded).scanner(app.secrets)), now: app.clock.now(), lease_ms: app.loaded.config.lease_ms };
        const ids = new Set(items.map((i) => i.id));
        for (const line of statusLines((await listRows(ctx, NO_FILTERS)).filter((r) => ids.has(r.item.id)))) console.log(line);
      }
    }
    await app.close();
    return 0;
  },
});
