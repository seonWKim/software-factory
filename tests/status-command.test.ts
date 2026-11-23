import { afterEach, describe, expect, it, vi } from "vitest";
import type { Loaded } from "../src/load-config.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { loadCommands } from "../src/cli/index.js";
import { ownerLine, statusLines } from "../src/cli/handlers/status/lines.js";
import { REASON_WORDS } from "../src/cli/handlers/status/reason-words.js";
import type { Timestamp } from "../src/core/types.js";
import { issue, newStore, system } from "./helpers/store.js";
import { cleanScanner } from "./helpers/fakes/config.js";

// The store the mocked `build` hands the status command; set by each test.
let current: { store: FactoryStore; clock: FakeClock };
vi.mock("../src/compose.js", async (orig) => {
  const real = await orig<typeof import("../src/compose.js")>();
  class FakePlugins { scanner = async () => cleanScanner; }
  return {
    ...real,
    Plugins: FakePlugins,
    build: async (loaded: Loaded) => ({ store: current.store, clock: current.clock, loaded, secrets: {}, close: async () => {} }),
  };
});

const row = (id: string, title: string, label: string, reason: string | null, reason_code = "spec_pending", params: Record<string, string | number> = {}) =>
  ({ item: { id, title, blocked_reason: reason }, label, why: { reason_code, params } }) as unknown as Parameters<typeof statusLines>[0][number];

const NOTHING = { count: 0, actions: [] };

describe("factory status lines", () => {
  it("prints one line per item: short id, title, state words, and the blocked reason in the dashboard's words", () => {
    const lines = statusLines([row("wi_c86970ff1234", "Add dark mode", "Needs you", "spec_pending"), row("wi_0123abcd9999", "Fix login", "Running", null)], NOTHING);
    expect(lines.slice(0, 2)).toEqual(["c86970ff  Add dark mode  Needs you: Waiting for a person to approve the spec", "0123abcd  Fix login  Running"]);
    for (const l of lines) expect(l).not.toContain("wi_");
  });

  it("words a failed step from its values, never from the stored code", () => {
    const [line] = statusLines([row("wi_c86970ff1234", "X", "Needs you", "run_failed:implement:checks_failed", "failed_implement", { failure: "Its checks failed." })], NOTHING);
    expect(line).toBe("c86970ff  X  Needs you: Building failed. Its checks failed. Decide what happens next");
    expect(line).not.toMatch(/[a-z]+_[a-z]+/);
  });

  it("says so when there is no item, and still ends with the owner line", () => {
    expect(statusLines([], NOTHING)).toEqual(["no work items", "Nothing needs you"]);
  });

  it("the owner line names the system actions and counts the items waiting", () => {
    expect(ownerLine({ count: 1, actions: ["Add a model credential"] })).toBe("Needs you (1): Add a model credential");
    expect(ownerLine({ count: 3, actions: ["Add a model credential"] })).toBe("Needs you (3): Add a model credential, 2 work items");
    expect(ownerLine(NOTHING)).toBe("Nothing needs you");
  });

  it("has a sentence for every reason code, with no underscore", () => {
    for (const [code, text] of Object.entries(REASON_WORDS)) expect(text, code).not.toMatch(/[a-z]+_[a-z]+/);
  });
});

describe("factory status command", () => {
  afterEach(() => vi.restoreAllMocks());

  async function run(...args: string[]): Promise<string[]> {
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((l: string) => void out.push(l));
    vi.spyOn(console, "table").mockImplementation(() => {});
    const loaded = { root: "/x", stateDir: "/x", file: {}, config: { repo: { owner: "o", name: "r" }, local_only: true, settings: { defaults: {}, projects: {} } } } as unknown as Loaded;
    const cmd = (await loadCommands()).get("status")!;
    expect(await cmd.run(args, { name: "status", usage: "", load: async () => loaded })).toBe(0);
    return out;
  }

  async function setup() {
    current = await newStore();
    for (const n of [1, 2]) await current.store.createWorkItem(issue(n), system, { enqueue: { kind: "triage", idempotency_key: `t${n}` } });
  }

  it("ends with the dashboard's Needs-you line while the model credential is missing", async () => {
    await setup();
    await current.store.pauseClaims("9999-12-31T23:59:59.999Z" as Timestamp, "model_credential");
    const out = await run();
    expect(out.at(-1)).toBe("Needs you (1): Add a model credential");
    expect(out.slice(0, -1).filter((l) => /^[0-9a-f]{8} /.test(l)).length).toBeGreaterThan(0);
    expect(out.join("\n")).not.toMatch(/[a-z]+_[a-z]+/);
  });

  it("ends with `Nothing needs you` when nothing waits on the owner", async () => {
    await setup();
    expect((await run()).at(-1)).toBe("Nothing needs you");
  });

  it("--json and --raw print no owner line", async () => {
    await setup();
    const json = (await run("--json")).join("\n");
    expect(JSON.parse(json)).toHaveLength(2);
    expect(json).not.toContain("Needs you");
    expect(await run("--raw")).toEqual([]);
  });
});
