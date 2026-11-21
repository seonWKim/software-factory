import { describe } from "vitest";
import type { Run, RunId, WorkItemId } from "../../src/core/types.js";
import type { PassportChecker } from "../../src/identity/index.js";
import { FakeClock } from "../../src/impl/clock/fake-clock.js";
import { LocalToolBroker } from "../../src/impl/broker/local-tool-broker.js";
import { PackToolBroker } from "../../src/impl/broker/pack-tool-broker.js";
import { PassportToolBroker } from "../../src/impl/broker/passport-broker.js";
import { GitHubToolBroker } from "../../src/impl/github/github-tool-broker.js";
import type { EgressScanner } from "../../src/interfaces/egress-scanner.js";
import type { FactoryStore } from "../../src/interfaces/factory-store.js";
import type { GitHubApi } from "../../src/interfaces/github-credentials.js";
import type { ToolBroker, ToolCallContext } from "../../src/interfaces/tool-broker.js";
import type { SqlDriver } from "../../src/state/index.js";
import { FakeBroker, FakeNoteBroker } from "../helpers/fakes/broker.js";
import { MemorySecretStore } from "../helpers/fakes/secrets.js";
import { type BrokerUnderTest, toolBrokerContract } from "./tool-broker.contract.js";

const RUN = "run_contract" as RunId;
const ITEM = "wi_contract" as WorkItemId;
const TOKEN = 7;
const held: ToolCallContext = { run_id: RUN, work_item_id: ITEM, lease_token: TOKEN };
/** Another claim took the run over: its token moved on. */
const lost: ToolCallContext = { ...held, lease_token: TOKEN - 1 };

/** The one run, running and leased with TOKEN: all the brokers read from the store. */
const runs = {
  getRun: async (id: RunId): Promise<Run | null> =>
    id === RUN ? ({ id: RUN, work_item_id: ITEM, status: "running", lease: { token: TOKEN } } as unknown as Run) : null,
};
const scanner: EgressScanner = { scan: async () => ({ clean: true }) };
/** No call in the contract reaches the GitHub API: lease, unknown-tool and branch checks come first. */
const github: GitHubApi = new Proxy({} as GitHubApi, {
  get: () => () => Promise.reject(new Error("the contract must not reach the GitHub API")),
});
const local = (): ToolBroker => new LocalToolBroker({ store: runs, scanner, branchPrefix: "factory/", repoPath: "/nonexistent" });

const IMPLEMENTATIONS: { name: string; storesBranches: boolean; make: () => BrokerUnderTest }[] = [
  { name: "LocalToolBroker", storesBranches: true, make: () => ({ broker: local(), held, lost }) },
  {
    name: "GitHubToolBroker",
    storesBranches: true,
    make: () => ({
      broker: new GitHubToolBroker({
        client: github,
        store: runs as unknown as FactoryStore,
        scanner,
        clock: new FakeClock(),
        repo: { owner: "o", name: "r" },
        branchPrefix: "factory/",
        repoPath: "/nonexistent",
      }),
      held,
      lost,
    }),
  },
  {
    // With no pack tools it is the inner broker's table and calls; a pack tool's own checks are tests/packs.test.ts's.
    name: "PackToolBroker over LocalToolBroker",
    storesBranches: true,
    make: () => ({
      broker: new PackToolBroker(local(), {
        db: {} as SqlDriver,
        store: runs,
        secrets: new MemorySecretStore(),
        tools: [],
        autoApproveReadOnly: false,
      }),
      held,
      lost,
    }),
  },
  {
    // A passport that allows every call: what is left is the inner broker's contract, which the wrapper must keep.
    name: "PassportToolBroker over LocalToolBroker",
    storesBranches: true,
    make: () => {
      const checker: PassportChecker = { check: async () => ({ allow: true }) as Awaited<ReturnType<PassportChecker["check"]>> };
      const passportOf = (run: string) => (run === RUN ? { token: "passport", project: "p", branch: "factory/contract" } : null);
      return { broker: new PassportToolBroker(local(), { checker, passportOf }), held, lost };
    },
  },
  { name: "FakeBroker", storesBranches: true, make: () => ({ broker: new FakeBroker({ store: runs }), held, lost }) },
  { name: "FakeNoteBroker", storesBranches: false, make: () => ({ broker: new FakeNoteBroker({}, runs), held, lost }) },
];

describe.each(IMPLEMENTATIONS)("ToolBroker contract: $name", ({ make, storesBranches }) => {
  toolBrokerContract(make, { storesBranches });
});
