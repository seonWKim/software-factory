// "You" in `factory setup` (owner decision 2026-11-08): the person's ID stays the CLI identity (cli_user, else
// local:<git user.email>, else local:<OS user>, else local:anonymous); setup asks for a display name, prefilled
// from git user.name, and Identity stores it once against that ID. The first person becomes the local owner, as
// on a first writing command; anyone later has no role (read and create only) until the owner grants one.

import { type ProfileStore, checkDisplayName } from "../../../identity/index.js";
import type { CliIdentity } from "../../../core/local-cli.js";
import type { FactoryStore } from "../../../interfaces/factory-store.js";
import type { Ask } from "./ask.js";

export interface MeDeps {
  store: Pick<FactoryStore, "claimLocalOwner" | "getLocalUser">;
  profiles: Pick<ProfileStore, "get" | "set">;
  identity: CliIdentity;
  /** git user.name: the default name, never an ID. */
  gitName: string | null;
  ask: Pick<Ask, "text">;
  /** ISO time of the write. */
  now: string;
}

/** Registers the person; `ok` false when nothing could be stored (the anonymous identity). */
export async function registerMe(d: MeDeps): Promise<{ ok: boolean; lines: string[] }> {
  const user = d.identity.user;
  if (d.identity.from === "anonymous") {
    return {
      ok: false,
      lines: [
        `   you are ${user}: nothing in this environment names you, so nothing is stored.`,
        "   Set git user.email (or cli_user in factory.config.json), then run `npm run setup -- --me`.",
      ],
    };
  }
  const existing = await d.profiles.get(user);
  const dflt = existing?.display_name ?? d.gitName ?? "";
  const answer = await d.ask.text("   Your display name (shown next to your ID in the CLI and UI)", dflt, (a) => {
    const c = checkDisplayName(a);
    return c.ok ? null : c.reason;
  });
  const checked = checkDisplayName(answer);
  const lines: string[] = [];
  if (checked.ok) {
    await d.profiles.set(user, checked.name, "self", d.now);
    lines.push(`   you are ${user} (from ${d.identity.from}), shown as "${checked.name}"`);
  } else {
    lines.push(`   you are ${user} (from ${d.identity.from}); no display name stored (${checked.reason}; git user.name is not set either)`);
  }
  const owner = await d.store.claimLocalOwner(user);
  if (owner.user_id === user) {
    lines.push("   you are the local owner: you may approve, merge and give others roles (`factory users add`)");
  } else {
    const role = (await d.store.getLocalUser(user))?.role ?? null;
    lines.push(
      role !== null
        ? `   your role: ${role} (given by the owner ${owner.user_id})`
        : `   no role yet: you may create and read work items. The owner (${owner.user_id}) can run \`factory users add ${user} --role approver\``,
    );
  }
  return { ok: true, lines };
}
