import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { WorkerId, WorkItemId } from "../src/core/types.js";
import { hasTool } from "../src/core/worker.js";
import { LocalToolBroker } from "../src/impl/broker/local-tool-broker.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { GitHubError, type GitHubClient } from "../src/impl/github/github-client.js";
import { GitHubToolBroker } from "../src/impl/github/github-tool-broker.js";
import { TOOL_ALIASES, type ToolBroker, type ToolCallContext } from "../src/interfaces/tool-broker.js";
import { cleanScanner, recordingLog } from "./helpers/fakes.js";
import { issue, newStore, system } from "./helpers/store.js";

/** An empty folder: not a git repo, so a push fails the same way under either name, and nothing is written. */
const EMPTY = mkdtempSync(join(tmpdir(), "sf-aliases-"));

// The forge rename, phase 1: both brokers serve forge.* tools; each old github.* name is an alias that runs the same
// code and logs one warning per process. The worker still asks for github.* names, so hasTool maps them.
// The alias warnings are once per process (module-level), and vitest runs each file in its own module graph: the
// warning test comes first, before any other test here calls an alias.

const ALIASES: [string, string][] = [
  ["github.push_branch", "forge.push_branch"],
  ["github.open_pr", "forge.open_change"],
  ["github.comment", "forge.comment"],
  ["github.preflight", "forge.preflight"],
];

/** The GitHub broker over a fake client: `fail` makes every request answer with that status. */
async function setup(o: { fail?: number } = {}) {
  const { store } = await newStore(new FakeClock());
  const { item } = await store.createWorkItem(issue(1), system, { enqueue: { kind: "implement", idempotency_key: "k" } });
  const run = (await store.claimRun({ worker_id: "w" as WorkerId, kinds: ["implement"], lease_ms: 60_000 }))!;
  const ctx: ToolCallContext = { run_id: run.id, work_item_id: item.id as WorkItemId, lease_token: run.lease!.token };
  const client = {
    async request(method: string, path: string) {
      if (o.fail) throw new GitHubError(o.fail, `GitHub ${method} → ${o.fail}`);
      if (method === "GET" && path.includes("/pulls")) return [];
      if (method === "GET") return { permissions: { push: true } };
      return { number: 5, html_url: "https://example.test/pull/5" };
    },
    async commentOnce() {
      if (o.fail) throw new GitHubError(o.fail, "nope");
      return { created: true };
    },
  } as unknown as GitHubClient;
  const log = recordingLog();
  const github = new GitHubToolBroker({
    client, credentials: { token: async () => null }, store, scanner: cleanScanner, clock: new FakeClock(),
    repo: { owner: "o", name: "r" }, branchPrefix: "factory/", log,
  });
  const local = new LocalToolBroker({ store, scanner: cleanScanner, branchPrefix: "factory/", repoPath: EMPTY, log });
  return { github, local, ctx, log };
}

const branch = "factory/wi_x";
/** Arguments per forge tool, the same for its alias. */
const ARGS: Record<string, unknown> = {
  "forge.push_branch": { workdir: EMPTY, branch, base_ref: "main" },
  "forge.open_change": { branch, base_ref: "main", title: "t", body: "b" },
  "forge.comment": { number: 1, body: "b", marker: "<!-- m -->" },
  "forge.preflight": { branch, base_ref: "main" },
};

describe("github.* aliases warn once per process", () => {
  it("logs one warning per alias naming it and its forge.* tool; a second call logs nothing", async () => {
    const f = await setup();
    for (const [old, forge] of ALIASES) await f.github.call(f.ctx, old, ARGS[forge]);
    expect(f.log.lines).toEqual(
      ALIASES.map(([old, forge]) => ({
        level: "warn",
        msg: expect.stringMatching(new RegExp(`${old.replace(".", "\\.")}.*${forge.replace(".", "\\.")}`)),
        fields: { tool: old, forge_tool: forge },
      })),
    );
    const before = f.log.lines.length;
    for (const [old, forge] of ALIASES) await f.github.call(f.ctx, old, ARGS[forge]);
    await f.local.call(f.ctx, "github.push_branch", ARGS["forge.push_branch"]);
    expect(f.log.lines).toHaveLength(before);
  });

  it("a forge.* name logs nothing", async () => {
    const f = await setup();
    for (const [, forge] of ALIASES) await f.github.call(f.ctx, forge, ARGS[forge]);
    expect(f.log.lines).toEqual([]);
  });
});

describe("the brokers' tool names", () => {
  it("the GitHub broker lists the forge.* tools; only forge.preflight is read-only", async () => {
    const { github } = await setup();
    expect(Object.fromEntries(github.allTools().map((t) => [t.name, t.read_only]))).toEqual({
      "forge.push_branch": false, "forge.open_change": false, "forge.comment": false, "forge.preflight": true,
    });
  });

  it("the local broker lists forge.push_branch only, not read-only", async () => {
    const { local } = await setup();
    expect(local.allTools().map((t) => ({ name: t.name, read_only: t.read_only }))).toEqual([{ name: "forge.push_branch", read_only: false }]);
  });

  it("no broker lists a github.* name", async () => {
    const { github, local } = await setup();
    for (const broker of [github, local] as ToolBroker[]) {
      expect(broker.allTools().filter((t) => t.name.startsWith("github."))).toEqual([]);
    }
  });

  it("the alias table maps each github.* name to its forge.* tool", () => {
    expect(Object.entries(TOOL_ALIASES)).toEqual(expect.arrayContaining(ALIASES));
  });
});

describe("an alias runs its forge.* tool", () => {
  for (const [old, forge] of ALIASES) {
    it(`${old} answers as ${forge}, on success and on error`, async () => {
      for (const fail of [undefined, 500]) {
        const a = await setup(fail ? { fail } : {});
        const b = await setup(fail ? { fail } : {});
        const viaAlias = await a.github.call(a.ctx, old, ARGS[forge]).catch((e: Error) => ({ thrown: e.message }));
        const viaForge = await b.github.call(b.ctx, forge, ARGS[forge]).catch((e: Error) => ({ thrown: e.message }));
        expect(viaAlias).toEqual(viaForge);
      }
      // A refused argument, before any request: the same error code.
      const f = await setup();
      const bad = forge === "forge.comment" ? { ...(ARGS[forge] as object), number: 0 } : { ...(ARGS[forge] as object), branch: "main" };
      const refused = await f.github.call(f.ctx, forge, bad);
      expect(refused).toMatchObject({ ok: false });
      expect(await f.github.call(f.ctx, old, bad)).toEqual(refused);
    });
  }

  it("on the local broker, github.push_branch answers as forge.push_branch; the other aliases are unknown tools", async () => {
    const f = await setup();
    for (const args of [ARGS["forge.push_branch"], { ...(ARGS["forge.push_branch"] as object), branch: "main" }]) {
      expect(await f.local.call(f.ctx, "github.push_branch", args)).toEqual(await f.local.call(f.ctx, "forge.push_branch", args));
    }
    for (const old of ["github.open_pr", "github.comment", "github.preflight"]) {
      expect(await f.local.call(f.ctx, old, {})).toMatchObject({ ok: false, error_code: "unknown_tool" });
    }
  });

  it("a stale lease is refused under either name", async () => {
    const f = await setup();
    const stale = { ...f.ctx, lease_token: f.ctx.lease_token + 1 };
    for (const [old, forge] of ALIASES) {
      expect(await f.github.call(stale, old, ARGS[forge])).toEqual(await f.github.call(stale, forge, ARGS[forge]));
    }
  });
});

describe("hasTool maps the worker's github.* names", () => {
  it("finds the PR, comment and preflight tools on the GitHub broker, and none on the local broker", async () => {
    const { github, local } = await setup();
    for (const name of ["github.preflight", "github.open_pr", "github.comment"]) {
      expect(hasTool(github, name), name).toBe(true);
      expect(hasTool(local, name), name).toBe(false);
    }
    expect(hasTool(github, "github.push_branch")).toBe(true);
    expect(hasTool(local, "github.push_branch")).toBe(true);
    expect(hasTool(local, "forge.open_change")).toBe(false);
    expect(hasTool(github, "github.nope")).toBe(false);
  });
});
