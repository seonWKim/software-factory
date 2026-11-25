import { Plugins, defineCommand, ownerRefusal } from "../../command.js";
import { ROUTINE_USAGE, parseRoutineArgs, runRoutineCommand, scheduleEquivalent } from "./routine.js";

export default defineCommand({
  names: ["routine"],
  usage: `  routine list | add <id> <flags> | edit <id> <flags> | pause <id> | resume <id> | delete <id> | run <id>
               manage routines (design 08-routines), as the routine API does: list prints each routine's ID, name,
               status (active or paused) and next run. add and edit take --name, --instruction, --url, --cadence
               with --spec, --zone, --trigger, --run-cap and --daily-cap (none clears one); delete also removes its
               suggestions; run is Run now. Every write needs approve_spec and the store's owner, as the CLI identity.
               An alias of factory schedule: it first prints the schedule equivalent (to stderr), then acts on the same row`,
  async run(args, ctx) {
    const action = parseRoutineArgs(args);
    if ("error" in action) {
      console.error(`${action.error}\n${ROUTINE_USAGE}`);
      return 1;
    }
    console.error(`factory routine is an alias; the schedule equivalent: ${scheduleEquivalent(args)}`);
    const { user } = await ctx.identity();
    return ctx.withStore(async (store, loaded) => {
      const clock = await new Plugins(loaded).clock();
      const r = await runRoutineCommand({ store, user, refusal: ownerRefusal(loaded, store, user, "approve_spec"), now: () => clock.now() }, action);
      for (const line of r.lines) (r.code === 0 ? console.log : console.error)(line);
      return r.code;
    });
  },
});
