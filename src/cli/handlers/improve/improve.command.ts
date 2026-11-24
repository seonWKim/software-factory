import { build, buildUiParts, writeSkillVerdict } from "../../../compose.js";
import { enqueueImprove } from "../../../core/improver.js";
import { type CommandContext, defineCommand } from "../../command.js";

const SKILL_USAGE = "usage: factory improve skill <draft id> promote|hold|reject";

export default defineCommand({
  names: ["improve"],
  usage: `  improve      queue one improve run now: groups the failed runs of the last 24 hours into one stored report
               (design §7); no model, nothing filed. The controller also queues one each UTC day
  improve skill <draft id> promote|hold|reject
               one verdict on a skill draft, as the Rules page's: promote writes the draft to the skill's SKILL.md and
               re-runs its suite first; hold and reject change only the draft. Owner only; a draft in another state, or a
               skill outside capabilities.skill_folders, is refused with nothing written`,
  async run(args, ctx) {
    if (args[0] === "skill") return skillVerdict(args.slice(1), ctx);
    // The same enqueue as the controller's daily step, with a key of its own (design §7); a worker runs it.
    const app = await build(await ctx.load());
    try {
      const { run } = await enqueueImprove(app, app.project.key, "manual");
      console.log(`improve run ${run.id} queued (window ${run.input?.improve?.window_start} to ${run.input?.improve?.window_end})`);
    } finally {
      await app.close();
    }
    return 0;
  },
});

/** `improve skill <id> <verdict>`: the Rules page's verdict function on the dashboard's parts, so both give the same result. */
async function skillVerdict(args: readonly string[], ctx: CommandContext): Promise<number> {
  const [id, verdict, ...rest] = args;
  if (id === undefined || verdict === undefined || rest.length > 0) {
    console.error(SKILL_USAGE);
    return 1;
  }
  const parts = await buildUiParts(await ctx.load(), { identity: await ctx.identity() });
  try {
    const r = await writeSkillVerdict(parts, parts.pauses, { id, verdict });
    const v = r.value as { state?: string; error?: string };
    if (r.status !== 200) {
      console.error(r.status === 400 ? `${v.error}\n${SKILL_USAGE}` : v.error);
      return 1;
    }
    console.log(`skill draft ${id} is ${v.state}`);
    return 0;
  } finally {
    await parts.close();
  }
}
