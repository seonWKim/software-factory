import { describe, expect, it } from "vitest";
import { STORE_BRANCH, type ToolBroker, type ToolCallContext } from "../../src/interfaces/tool-broker.js";

// RFC 0023 R2: the ToolBroker contract (src/interfaces/tool-broker.ts), run over every implementation by
// tool-broker.contract.test.ts. G2: the worker grants tools from listTools, startup checks `tool_grants` against
// allTools, and every call is fenced on the run's lease. Tool-specific results (a store's sha, a preflight's checks)
// are each broker's own tests; this suite holds what every broker, real or fake, shares.

/** One broker under test, with a context whose run holds its lease and one whose run lost it. */
export interface BrokerUnderTest {
  broker: ToolBroker;
  held: ToolCallContext;
  lost: ToolCallContext;
}

/**
 * `storesBranches`: the broker serves `git.store_branch` (a run's broker; FakeNoteBroker, a grants fake, does not).
 * The store cases are skipped for the others, and the first of them checks the flag against allTools.
 */
export function toolBrokerContract(make: () => BrokerUnderTest | Promise<BrokerUnderTest>, opts: { storesBranches: boolean }): void {
  const noStore = !opts.storesBranches;
  describe("listTools and allTools", () => {
    // Bug: a tool nobody granted is listed, so a run gets a tool its grants never named (design §7).
    it("lists nothing for no grants", async () => {
      const { broker } = await make();
      expect(broker.listTools([])).toEqual([]);
    });

    // Bug: listTools ignores the grant list, or makes up a tool for a grant the broker does not serve.
    it("lists exactly the granted tools it serves", async () => {
      const { broker } = await make();
      const all = broker.allTools().map((t) => t.name);
      expect(all.length).toBeGreaterThan(0);
      expect(broker.listTools([all[0]!, "contract.no_such_tool"]).map((t) => t.name)).toEqual([all[0]]);
      expect(broker.listTools(all).map((t) => t.name).sort()).toEqual([...all].sort());
    });

    // Bug: two tools share a name, so a grant or a call is ambiguous; or a schema that is not an object, which the
    // agent's tool bridge cannot offer.
    it("names each tool once, each with a description, an object schema and a read_only flag", async () => {
      const { broker } = await make();
      const tools = broker.allTools();
      expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
      for (const t of tools) {
        expect(t.description.length).toBeGreaterThan(0);
        expect(t.input_schema).toMatchObject({ type: "object" });
        expect(typeof t.read_only).toBe("boolean");
      }
    });

    // Bug: the branch store is flagged read-only, so startup lets `tool_grants` hand an agent a tool that writes refs.
    it.skipIf(noStore)("never flags git.store_branch read-only", async () => {
      const { broker } = await make();
      const store = broker.allTools().find((t) => t.name === STORE_BRANCH);
      expect(store).toBeDefined();
      expect(store!.read_only).toBe(false);
    });
  });

  describe("call", () => {
    // Bug: a run that lost its lease still stores a branch or reaches the forge after another claim took it over.
    it("refuses every tool with lease_lost for a run that lost its lease", async () => {
      const { broker, lost } = await make();
      for (const t of broker.allTools()) {
        const r = await broker.call(lost, t.name, { workdir: "/nonexistent", branch: "factory/contract", base_ref: "main" });
        expect(r, t.name).toMatchObject({ ok: false, error_code: "lease_lost" });
      }
    });

    // Bug: a call for a tool the broker does not serve succeeds, so a typo or a removed tool fails silently.
    it("answers unknown_tool for a tool it does not serve", async () => {
      const { broker, held } = await make();
      expect(await broker.call(held, "contract.no_such_tool", {})).toMatchObject({ ok: false, error_code: "unknown_tool" });
    });

    // Bug: the store writes a branch outside the factory's prefix, such as a person's `main`.
    it.skipIf(noStore)("refuses to store a branch outside the factory prefix", async () => {
      const { broker, held } = await make();
      const r = await broker.call(held, STORE_BRANCH, { workdir: "/nonexistent", branch: "main", base_ref: "main" });
      expect(r).toMatchObject({ ok: false, error_code: "branch_not_allowed" });
    });
  });
}
