// `factory routine` (design 08-routines): add, edit, pause, resume, delete, run (Run now) and list. Each write is
// the routine API's (src/ui/routines-api.ts): the arguments, then the owner check, then the core's writeRoutine with
// the same arguments, so the CLI and the API do the same thing. Time is passed in, read from the injected Clock.

import { type CliIdentity, type FactoryStore, type Routine, type RoutineFields, type RoutineWrite, writeRoutine } from "../../command.js";

export const ROUTINE_USAGE = `usage: factory routine list
       factory routine add <id> --name <name> --instruction <text> (--cadence <kind> --spec <spec> | --trigger merge) [flags]
       factory routine edit <id> [flags]
       factory routine pause|resume|delete|run <id>
flags: --name <name>  --instruction <text>  --url <url|none>  --cadence <interval|daily|weekly|cron|none>  --spec <spec>
       --zone <zone>  --trigger <merge|none>  --run-cap <usd|none>  --daily-cap <usd|none>`;

export type RoutineAction = { op: "list" } | { op: RoutineWrite; id: string; fields: RoutineFields };

const WRITES: readonly RoutineWrite[] = ["add", "edit", "pause", "resume", "delete", "run"];
const FLAGS = ["--name", "--instruction", "--url", "--cadence", "--spec", "--zone", "--trigger", "--run-cap", "--daily-cap"] as const;
type Flag = (typeof FLAGS)[number];

const orNull = (v: string): string | null => (v === "none" ? null : v);

function usdOf(flag: string, v: string): number | null | string {
  if (v === "none") return null;
  const n = Number(v);
  return v.trim() !== "" && Number.isFinite(n) ? n : `${flag} takes a dollar amount or none, not "${v}"`;
}

/** The fields the flags give, or why they are bad; the core checks each value's meaning (routineProblem). */
function fieldsOf(args: readonly string[]): RoutineFields | string {
  const given: Partial<Record<Flag, string>> = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]!, value = args[i + 1];
    if (!(FLAGS as readonly string[]).includes(flag)) return `unknown argument "${flag}"`;
    if (value === undefined) return `${flag} needs a value`;
    if (given[flag as Flag] !== undefined) return `${flag} is given twice`;
    given[flag as Flag] = value;
  }
  const f: RoutineFields = {};
  if (given["--name"] !== undefined) f.name = given["--name"];
  if (given["--instruction"] !== undefined) f.instruction = given["--instruction"];
  if (given["--url"] !== undefined) f.url = orNull(given["--url"]);
  if (given["--zone"] !== undefined) f.zone = given["--zone"];
  if (given["--trigger"] !== undefined) f.trigger = orNull(given["--trigger"]) as Routine["trigger"];
  const cadence = given["--cadence"], spec = given["--spec"];
  if (cadence === "none") {
    if (spec !== undefined) return "--spec goes with a --cadence, not with none";
    f.schedule = null;
  } else if (cadence !== undefined || spec !== undefined) {
    if (cadence === undefined || spec === undefined) return "--cadence and --spec go together";
    f.schedule = { kind: cadence, spec } as Routine["schedule"];
  }
  for (const [flag, key] of [["--run-cap", "run_cap_usd"], ["--daily-cap", "daily_cap_usd"]] as const) {
    const v = given[flag];
    if (v === undefined) continue;
    const usd = usdOf(flag, v);
    if (typeof usd === "string") return usd;
    f[key] = usd;
  }
  return f;
}

/** The subcommand and its fields, or why the arguments are bad (no store call). */
export function parseRoutineArgs(args: readonly string[]): RoutineAction | { error: string } {
  const [op, id, ...rest] = args;
  if (op === "list") return id === undefined ? { op: "list" } : { error: "factory routine list takes no arguments" };
  if (!(WRITES as readonly string[]).includes(op ?? "")) return { error: op === undefined ? "give a subcommand" : `unknown subcommand "${op}"` };
  const w = op as RoutineWrite;
  if (id === undefined || id.trim() === "" || id.startsWith("--")) return { error: `factory routine ${w} needs the routine's ID` };
  if (w !== "add" && w !== "edit") return rest.length === 0 ? { op: w, id: id.trim(), fields: {} } : { error: `factory routine ${w} takes only the routine's ID` };
  const fields = fieldsOf(rest);
  return typeof fields === "string" ? { error: fields } : { op: w, id: id.trim(), fields };
}

/** What the command runs with: the store, the CLI identity, its owner check (ownerRefusal, approve_spec) and the Clock's now. */
export interface RoutineCommandDeps {
  store: Pick<FactoryStore, "addRoutine" | "getRoutine" | "listRoutines" | "updateRoutine" | "editRoutine" | "deleteRoutine" | "getOwner">;
  user: CliIdentity["user"];
  refusal: () => Promise<string | null>;
  now: () => Date;
}

/** One list line: ID, name, status, next run (a trigger routine's trigger, or none). */
export function routineLine(r: Routine): string {
  const next = r.trigger !== null ? `on ${r.trigger}` : (r.next_due_at ?? "none");
  return [r.id, r.name, r.paused ? "paused" : "active", next].join("  ");
}

const DONE: Readonly<Record<Exclude<RoutineWrite, "run">, string>> = { add: "added", edit: "edited", pause: "paused", resume: "resumed", delete: "deleted" };

/** Runs one action: its exit code and the lines to print (stdout on 0, stderr otherwise). */
export async function runRoutineCommand(d: RoutineCommandDeps, a: RoutineAction): Promise<{ code: number; lines: string[] }> {
  if (a.op === "list") {
    const all = await d.store.listRoutines();
    return { code: 0, lines: all.length === 0 ? ["no routine is stored"] : all.map(routineLine) };
  }
  // The owner check, as the API's (rules-api.ts ownerOf): the local auth decision, then the store's owner.
  const reason = await d.refusal();
  if (reason !== null) return { code: 1, lines: [`Only the owner manages routines: ${reason}.`] };
  if ((await d.store.getOwner()) !== d.user) return { code: 1, lines: [`Only the owner manages routines; you are ${d.user}.`] };
  const r = await writeRoutine(d.store, a.op, a.id, a.fields, d.user, d.now());
  if (!r.ok) return { code: 1, lines: [`not changed: ${r.problem}`] };
  const done = a.op === "run" ? `routine ${a.id} runs on the next tick` : `${DONE[a.op]} routine ${a.id}`;
  return { code: 0, lines: a.op === "delete" ? [done] : [done, routineLine(r.routine)] };
}
