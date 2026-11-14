// The idle agents' sandbox Gongbang (local development process, scripts/idle-agents.mjs): the responsive check's
// seeded throwaway store (scripts/responsive/fixture.mjs) served by the real UI server on a free port, plus a Rules
// page backed by a throwaway copy of the owner's agents home, so verdicts, promotes and retires run the real
// `tacit` and `evolve` CLIs without touching the real ledger. `sync-agents` in the copy is a no-op: it would write
// into the owner's real agent instruction files. Prints `SANDBOX_URL=<url>` once ready; stops and deletes
// everything on SIGTERM or SIGINT. Needs a build (`npm run build`) first.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { checkAgentsHome, tacitLedgerAt } from "../../dist/impl/tacit/agents-home-tacit-ledger.js";
import { startFixture } from "../responsive/fixture.mjs";

/** A copy of the owner's agents home (no git history, no logs), or null when there is none. */
async function sandboxHome() {
  const real = process.env.AGENTS_HOME || join(homedir(), ".agents");
  if (!existsSync(join(real, "bin", "tacit"))) return null;
  const dir = await mkdtemp(join(tmpdir(), "gongbang-sandbox-agents-"));
  execFileSync("rsync", ["-a", "--exclude", ".git", "--exclude", "private/.git", "--exclude", "private/logs", `${real}/`, `${dir}/`]);
  const sync = join(dir, "bin", "sync-agents");
  writeFileSync(sync, "#!/bin/sh\n# sandbox: the real sync-agents writes the owner's agent instruction files\nexit 0\n");
  chmodSync(sync, 0o755);
  return dir;
}

const home = await sandboxHome();
// The CLIs find their ledgers from AGENTS_HOME in their own environment, which they inherit from this process:
// without this line a sandbox verdict would land in the owner's real ledger.
if (home) process.env.AGENTS_HOME = home;
delete process.env.AGENTS_PRIVATE;
delete process.env.TACIT_HOME;
const env = home ? { AGENTS_HOME: home } : {};
const tacit = home
  ? {
      ledger: tacitLedgerAt(env),
      settings: { refresh: async () => {}, values: () => ({ integrations: { tacit: "agents-home" } }) },
      home: () => checkAgentsHome(env),
    }
  : undefined;
const quiet = new Proxy({}, { get: () => () => {} });
// `pauses` wires the owner-checked write routes (Rules verdicts, pack approvals, resume): in the sandbox the acting
// user is the store's owner.
const fixture = await startFixture(async ({ store, csrfToken, owner }) => {
  await store.claimOwner(owner);
  return {
    ...(tacit ? { tacit } : {}),
    pauses: { principal: async () => owner, authorize: async () => ({ allow: true }), csrfToken, log: quiet },
  };
});
console.log(`SANDBOX_URL=${fixture.url}`);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await fixture.close();
  if (home) await rm(home, { recursive: true, force: true });
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
