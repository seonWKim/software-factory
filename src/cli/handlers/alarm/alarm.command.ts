import { defineCommand, ownerRefusal } from "../../command.js";

const USAGE = "usage: factory alarm dismiss <alert id>";

export default defineCommand({
  names: ["alarm"],
  usage: `  alarm dismiss <id>
               hide an open alarm (design 05-alarms) until its pattern alerts again: its pattern then counts only the
               runs that finish after now, so a failure that goes on brings it back. Lifts no hold. The id is the
               alarm's alert_id (GET /api/v1/overview). Needs approve_spec (the owner check, as the dashboard's
               Dismiss); the store keeps the CLI identity's user ID and the time`,
  async run(args, ctx) {
    const [sub, id, ...rest] = args;
    if (sub !== "dismiss" || id === undefined || id === "" || rest.length > 0) {
      console.log(USAGE);
      return 1;
    }
    // An ID, never a display name: the CLI identity, the one the owner check asks about.
    const { user } = await ctx.identity();
    return ctx.withStore(async (store, loaded) => {
      const refused = await ownerRefusal(loaded, store, user, "approve_spec")();
      if (refused !== null) {
        console.error(`not dismissed: ${refused}`);
        return 1;
      }
      const r = await store.dismissAlert(id, user);
      if (r === null) {
        console.error(`no alert ${id}`);
        return 1;
      }
      console.log(r.dismissed ? `dismissed the alarm ${id} (${r.pattern_key}) as ${user}` : `the alarm ${id} was already dismissed at ${r.dismissed_at}`);
      return 0;
    });
  },
});
