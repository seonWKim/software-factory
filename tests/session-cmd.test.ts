import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionParts } from "../src/compose.js";
import { StoredLearnedSettings } from "../src/core/learned-settings.js";
import { settingValues } from "../src/core/settings.js";
import { splitThresholds } from "../src/core/split.js";
import type { Timestamp } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { runSession, sessionDeps } from "../src/session-cmd.js";
import { FakeAuth, FakeBroker, FakeSandbox, PROJECT, cleanScanner, config } from "./helpers/fakes.js";
import { newStore } from "./helpers/store.js";

// A session built through sessionDeps reads the learned layer (design 08-settings) as a run does.

/** A spec of 100 lines in one file: under the split threshold of the default limit, over the one of a learned limit of 100. */
const SPEC = {
  in_short: "AS-IS: nothing.\nTO-BE: something.", problem: "Fix the widget", done_criteria: ["the widget works"], desired_output: "a PR",
  scope: "the widget only", allowed_paths: ["src/a/"], files_to_change: ["src/a/x.ts"], tier: 2, tier_reason: "small", estimated_lines: 100, estimated_files: 1,
};

async function parts(store: FactoryStore, clock: FakeClock): Promise<{ parts: SessionParts; learned: StoredLearnedSettings }> {
  const learned = new StoredLearnedSettings(store);
  await learned.refresh();
  // GitHub knows the person and no issue: a start that passes the spec check stops at the issue lookup.
  const github = { request: async <T>(_m: string, path: string) => (path.startsWith("/users/") ? { id: 1 } : {}) as T } as unknown as SessionParts["github"];
  const broker = new FakeBroker();
  const sandbox = new FakeSandbox();
  return {
    learned,
    parts: {
      clock, store, scanner: cleanScanner, sandbox, broker, auth: new FakeAuth(), github, config, local: { broker, sandbox } as unknown as SessionParts["local"],
      learned, close: async () => {},
    },
  };
}

async function start(p: SessionParts): Promise<string[]> {
  const lines: string[] = [];
  const d = { ...sessionDeps(p, mkdtempSync(join(tmpdir(), "session-cmd-")), new AbortController().signal), readSpec: async () => JSON.stringify(SPEC), print: (l: string) => lines.push(l) };
  await runSession(d, { cmd: "start", target: "7", spec: "spec.json" });
  return lines;
}

describe("factory session through sessionDeps", () => {
  it("a session gets the learned max_diff_lines for its project, as a run does", async () => {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    await store.setLearnedSetting({
      project: PROJECT.key, key: "max_diff_lines", expected: null, value: "100", evidence_run_ids: [], window_end: "2026-03-05T00:00:00.000Z" as Timestamp, actor: "improver",
    });
    const { parts: p, learned } = await parts(store, clock);
    const limits = settingValues(PROJECT.key, config.settings, learned);
    expect(limits.max_diff_lines).toBe(100);
    const lines = (await start(p)).join("\n");
    expect(lines).toContain("refused: the --spec file is not a valid spec");
    expect(lines).toContain(`(${splitThresholds(limits).lines} lines or`);
  });

  it("with no learned value the project's limit applies and the same spec passes the split check", async () => {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const { parts: p } = await parts(store, clock);
    expect((await start(p)).join("\n")).not.toContain("phases");
  });
});
