import { describe, expect, it } from "vitest";
import type { FactoryConfig } from "../src/core/config.js";
import type { UserId, WorkItem } from "../src/core/types.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { FakeAuth, FakeSource, cleanScanner, config, silent } from "./helpers/fakes.js";
import { PROJECT_KEY, newStore } from "./helpers/store.js";

// The local merge's reply says how to run the result (design 04-gate-commands, restart): with `repo.restart_command`
// set, the Restart app button and `factory restart`; without it, the repo's README.md and bin/ when they exist, else
// that no run command is set. Startup never fails for its absence.

const ME = "local:me@example.com" as UserId;

async function mergedReply(o: { restart_command?: string[]; entries?: string[] | null }) {
  const { store, clock } = await newStore();
  const cfg: FactoryConfig = { ...config, repo: { ...config.repo, ...(o.restart_command ? { restart_command: o.restart_command } : {}) } };
  const asked: (readonly string[])[] = [];
  const entries = o.entries === null ? {} : { repo_entries: async (names: readonly string[]) => (asked.push(names), names.filter((n) => (o.entries ?? []).includes(n))) };
  const controller = new ControllerRole({ store, sources: [new FakeSource()], auth: new FakeAuth(), clock, config: cfg, log: silent, scanner: cleanScanner, ...entries });
  const actor = { kind: "system" as const, id: "system:test" };
  const { item } = await store.createWorkItem({ source: { type: "local", id: "local-1", link: "local:local-1" }, requester_id: ME, project: PROJECT_KEY, problem: "p", resources: [] }, actor);
  const r = await store.transition({ id: item.id, expected_version: item.version, actor, reason: "setup", patch: { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending" } });
  if (!r.ok) throw new Error("setup failed");
  const it: WorkItem = r.item;
  expect(await (await controller.unit("local-merge")).merged(it.id, ME, "k1", { sha: "abcdef0123456789", already: false, not_updated: [] }, {})).toBe("landed");
  const bodies = (await store.listItemMessages(it.id)).filter((m) => m.marker === "<!-- factory:local-merged:k1 -->").map((m) => m.body);
  expect(bodies).toHaveLength(1);
  return { body: bodies[0]!, asked, item: (await store.getWorkItem(it.id))! };
}

describe("the local merge reply: how to run the result", () => {
  it("with repo.restart_command: points to Restart app and `factory restart <id>`, and reads nothing in the repo", async () => {
    const { body, asked, item } = await mergedReply({ restart_command: ["bin/restart"], entries: ["README.md", "bin"] });
    expect(item).toMatchObject({ stage: "CLOSED", close_reason: "completed" });
    expect(body).toContain(`press Restart app on the item's page or run \`factory restart ${item.id}\``);
    expect(body).not.toContain("No run command is set");
    expect(asked).toEqual([]);
  });

  it("without it: names README.md and bin/ when the repo has them, after the merge line", async () => {
    const { body, asked } = await mergedReply({ entries: ["README.md", "bin"] });
    expect(body).toMatch(/^Merged `/);
    expect(body).toContain("To run the merged code, see `README.md` and the scripts in `bin/` in the repository.");
    expect(body).toContain("No run command is set");
    expect(asked).toEqual([["README.md", "bin"]]);
  });

  it("without it and with neither entry, or no way to look: says only that no run command is set", async () => {
    for (const entries of [[], null]) {
      const { body } = await mergedReply({ entries });
      expect(body).toContain("No run command is set");
      expect(body).not.toContain("README.md");
      expect(body).not.toContain("`bin/`");
    }
  });
});
