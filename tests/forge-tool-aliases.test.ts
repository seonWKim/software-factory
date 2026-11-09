import { describe, expect, it } from "vitest";
import type { WorkerId, WorkItemId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { type GitHubClient } from "../src/impl/github/github-client.js";
import { GitHubToolBroker } from "../src/impl/github/github-tool-broker.js";
import { PREFLIGHT, TOOL_ALIASES, type ToolCallContext } from "../src/interfaces/tool-broker.js";
import { cleanScanner, recordingLog } from "./helpers/fakes.js";
import { issue, newStore, system } from "./helpers/store.js";

// The forge rename: the preflight is `forge.preflight`, so core code names no forge; the old `github.preflight` is an
// alias that runs the same code and logs one warning per process. The warning is module-level (once per process), and
// vitest runs each file in its own module graph: the warning test comes first, before any other test here calls it.

async function setup() {
  const { store } = await newStore(new FakeClock());
  const { item } = await store.createWorkItem(issue(1), system, { enqueue: { kind: "implement", idempotency_key: "k" } });
  const run = (await store.claimRun({ worker_id: "w" as WorkerId, kinds: ["implement"], lease_ms: 60_000 }))!;
  const ctx: ToolCallContext = { run_id: run.id, work_item_id: item.id as WorkItemId, lease_token: run.lease!.token };
  const requests: string[] = [];
  const client = {
    async request(method: string, path: string) {
      requests.push(`${method} ${path}`);
      return path.includes("/pulls") ? [] : { permissions: { push: true } };
    },
  } as unknown as GitHubClient;
  const log = recordingLog();
  const broker = new GitHubToolBroker({
    client, store, scanner: cleanScanner, clock: new FakeClock(),
    repo: { owner: "o", name: "r" }, branchPrefix: "factory/", log,
  });
  return { broker, ctx, log, requests };
}

const ARGS = { branch: "factory/wi_x", base_ref: "main" };

describe("forge-neutral tool names", () => {
  it("the old name runs the preflight and warns once per process, naming both", async () => {
    const t = await setup();
    const first = await t.broker.call(t.ctx, "github.preflight", ARGS);
    const second = await t.broker.call(t.ctx, "github.preflight", ARGS);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ ok: true });
    const warns = t.log.lines.filter((l) => l.level === "warn");
    expect(warns).toHaveLength(1);
    expect(warns[0]!.msg).toContain("github.preflight");
    expect(warns[0]!.msg).toContain(PREFLIGHT);
  });

  it("the broker lists only the forge-neutral name, and the alias gives the same result with the same calls", async () => {
    const a = await setup();
    const b = await setup();
    expect(a.broker.allTools().map((t) => t.name)).toContain(PREFLIGHT);
    expect(a.broker.allTools().map((t) => t.name)).not.toContain("github.preflight");
    expect(await a.broker.call(a.ctx, PREFLIGHT, ARGS)).toEqual(await b.broker.call(b.ctx, "github.preflight", ARGS));
    expect(a.requests).toEqual(b.requests);
  });

  it("the alias table maps only names no broker lists", () => {
    expect(TOOL_ALIASES).toEqual({ "github.preflight": PREFLIGHT });
  });
});
