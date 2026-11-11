import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type Loaded, Plugins, localAuth } from "../../../compose.js";
import { cliUserConfig } from "../../../core/config.js";
import { cliIdentity } from "../../../core/local-cli.js";
import { storeSql } from "../../../impl/store/sql/store-sql.js";
import { type ApprovalRequest, PackApprovalsStore, approvalLine, changeApproval } from "../../../packs/pack-approvals.store.js";
import { PackEntriesStore, addLine, addPack } from "../../../packs/pack-entries.store.js";
import { defineCommand } from "../../command.js";
import { cliEnvironment } from "../../support.js";

const USAGE = "usage: factory pack add <path> | factory pack approve|revoke <tool|mcp_server> <name> [<description_hash>]";

/** The parsed arguments, or null when they are not a pack command. */
function parse(args: readonly string[]): { sub: "add"; path: string } | ({ sub: "approval" } & ApprovalRequest) | null {
  const [sub, ...rest] = args;
  if (sub === "add" && rest.length === 1) return { sub, path: rest[0]! };
  if ((sub === "approve" || sub === "revoke") && (rest.length === 2 || rest.length === 3)) {
    const [kind, name, hash] = rest as [string, string, string?];
    return { sub: "approval", action: sub, kind, name, ...(hash === undefined ? {} : { hash }) };
  }
  return null;
}

/** What both subcommands use: the CLI identity's user ID and the configured store, scanner and clock. */
interface Opened {
  loaded: Loaded;
  user: ReturnType<typeof cliIdentity>["user"];
  store: Awaited<ReturnType<Plugins["store"]>>;
  scanner: Awaited<ReturnType<Plugins["scanner"]>>;
  now: () => string;
}

export default defineCommand({
  names: ["pack"],
  usage: `  pack add <path>
               scans the pack's tools/*.json and mcp_servers/*.json (egress, credential leak, tool poisoning) and
               stores each passing entry as pending; a failing one is refused, naming the rule. Starts nothing.
               Exits 1 when any entry is refused
  pack approve|revoke <tool|mcp_server> <name> [<description_hash>]
               approves or revokes one stored description of an entry (absent hash: the current one) as the CLI
               identity; needs approve_tool (the owner). A changed description needs its own approval`,
  async run(args, ctx) {
    const cmd = parse(args);
    if (cmd === null) {
      console.error(`${USAGE}\n\n${ctx.usage}`);
      return 1;
    }
    const loaded = await ctx.load();
    let cliUser;
    try {
      cliUser = cliUserConfig(loaded.file);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      return 1;
    }
    const user = cliIdentity(cliUser, await cliEnvironment(loaded.root)).user;
    // The configured clock, egress scanner and store, through the same registry as build() (design 11-packs).
    const p = new Plugins(loaded);
    const clock = await p.clock();
    const secrets = await p.secrets();
    const scanner = await p.scanner(secrets);
    await mkdir(join(loaded.stateDir, "db"), { recursive: true, mode: 0o700 });
    const store = await p.store(secrets, clock);
    try {
      await store.migrate();
      const o: Opened = { loaded, user, store, scanner, now: () => clock.now().toISOString() };
      return cmd.sub === "add" ? await add(o, cmd.path) : await approval(o, cmd);
    } finally {
      await store.close();
    }
  },
});

async function add(o: Opened, path: string): Promise<number> {
  const entries = new PackEntriesStore(storeSql(o.store), o.now);
  const results = await addPack({ path: resolve(path), store: entries, scanner: o.scanner, added_by: o.user });
  if (results.length === 0) console.log(`no tools/*.json or mcp_servers/*.json under ${resolve(path)}`);
  for (const r of results) (r.outcome === "refused" ? console.error : console.log)(addLine(r));
  return results.some((r) => r.outcome === "refused") ? 1 : 0;
}

/** Solo: the local auth plugin's owner check, no external account. The row stores the CLI identity's user ID. */
async function approval(o: Opened, r: ApprovalRequest): Promise<number> {
  const db = storeSql(o.store);
  const auth = await localAuth(o.loaded, o.store);
  const result = await changeApproval({ auth, entries: new PackEntriesStore(db, o.now), approvals: new PackApprovalsStore(db, o.now), user_id: o.user }, r);
  (result.ok ? console.log : console.error)(approvalLine(r, result));
  return result.ok ? 0 : 1;
}
