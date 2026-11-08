// The Merge button's readiness facts in the running app (design §9): compose.ts buildUiParts fills in whether a
// forge is selected and whether the selected sandbox can merge locally, so `no forge selected` and `no sandbox
// that can merge` come from the real wiring, not only from fields a unit test sets by hand.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Loaded, buildUiParts, loadConfig } from "../src/compose.js";
import type { CliIdentity } from "../src/core/local-cli.js";
import type { UserId, WorkItem } from "../src/core/types.js";
import type { Sandbox } from "../src/interfaces/sandbox.js";
import { withPlugin } from "../src/plugins.js";
import { mergeReadiness } from "../src/ui/commands.js";
import type { UiDeps } from "../src/ui/pages.js";
import { issue, system } from "./helpers/store.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const REAL = JSON.parse(readFileSync(join(REPO_ROOT, "factory.config.json"), "utf8")) as Record<string, unknown>;
const ME: CliIdentity = { user: "local:me@example.com" as UserId, from: "git user.email" };
/** A sandbox plugin with no local merge: the shape of a sandbox that cannot merge. */
const NO_MERGE = "no-merge";

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A throwaway repo root with the real config on SQLite, its prompts and a secret file. */
async function loaded(plugins: Record<string, unknown> = {}): Promise<Loaded> {
  const dir = mkdtempSync(join(tmpdir(), "sf-ui-merge-"));
  mkdirSync(join(dir, "prompts"));
  for (const p of ["triage", "implement", "review"]) writeFileSync(join(dir, "prompts", `${p}.md`), p);
  writeFileSync(join(dir, "factory.config.json"), JSON.stringify({ ...REAL, store: { type: "sqlite" }, plugins: { ...(REAL.plugins as object), ...plugins } }));
  mkdirSync(join(dir, "secrets"));
  writeFileSync(join(dir, "secrets", ".env"), "MYSQL_PASSWORD=pw\nGITHUB_TOKEN=gh\n");
  vi.stubEnv("SOFTWARE_FACTORY_SECRETS_FILE", join(dir, "secrets", ".env"));
  return loadConfig(dir);
}

/** The readiness of a GitHub PR and a local item with no PR, both waiting for their merge, under the parts' commands. */
async function readiness(l: Loaded) {
  const parts = await buildUiParts(l, { identity: ME });
  try {
    const at = async (source: WorkItem["source"], change_ref: string | null) => {
      const { item } = await parts.store.createWorkItem({ ...issue(1), source }, system);
      const r = await parts.store.transition({
        id: item.id, expected_version: item.version, actor: system, reason: "seed",
        patch: { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", change_ref },
      });
      if (!r.ok) throw new Error(r.reason);
      // Only the commands reach the readiness: the rest of UiDeps is not read.
      return mergeReadiness({ commands: parts.commands } as UiDeps, r.item, null, async () => true);
    };
    return {
      github: await at({ type: "github_issue", id: "o/r#1", link: "https://github.com/o/r/issues/1" }, "42"),
      local: await at({ type: "local", id: "local-1", link: "local:local-1" }, null),
    };
  } finally {
    await parts.close();
  }
}

describe("ui wiring: the Merge button's readiness facts (buildUiParts)", () => {
  it("a GitHub item says no forge selected when config selects no forge", async () => {
    const l = await loaded({ source: ["local"], forge: null });
    expect(l.plugins.forge).toBeUndefined();
    expect((await readiness(l)).github).toEqual({ enabled: false, reason: "no forge selected" });
  });

  it("a local item says no sandbox that can merge when the selected sandbox cannot merge", async () => {
    const l = await loaded();
    const cannot = { ...l, registry: withPlugin(l.registry, "sandbox", NO_MERGE, () => ({}) as Sandbox), plugins: { ...l.plugins, sandbox: NO_MERGE } };
    expect((await readiness(cannot)).local).toEqual({ enabled: false, reason: "no sandbox that can merge" });
  });

  it("with a forge selected and the noop sandbox, neither reason is given", async () => {
    const l = await loaded();
    expect(l.plugins.forge).toBeDefined();
    const r = await readiness(l);
    expect(r.github.reason).not.toBe("no forge selected");
    expect(r.local.reason).not.toBe("no sandbox that can merge");
  });
});
