import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/load-config.js";
import { SKILL_IMPROVE_DEFAULTS, skillImproveConfig } from "../src/core/config.js";
import { ConfigKeyError } from "../src/config-keys.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const REAL = JSON.parse(readFileSync(join(REPO_ROOT, "factory.config.json"), "utf8")) as Record<string, unknown>;
const SQLITE = { ...REAL, store: { type: "sqlite" } };

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A throwaway repo root with its own config, prompts and secret file. */
function root(config: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "sf-config-"));
  mkdirSync(join(dir, "prompts"));
  for (const p of ["triage", "implement", "review"]) writeFileSync(join(dir, "prompts", `${p}.md`), p);
  writeFileSync(join(dir, "factory.config.json"), JSON.stringify(config));
  mkdirSync(join(dir, "secrets"));
  writeFileSync(join(dir, "secrets", ".env"), "GITHUB_TOKEN=gh\n");
  vi.stubEnv("SOFTWARE_FACTORY_SECRETS_FILE", join(dir, "secrets", ".env"));
  return dir;
}

async function loadError(config: Record<string, unknown>): Promise<Error> {
  const err = await loadConfig(root(config)).then(
    () => null,
    (e: Error) => e,
  );
  if (!err) throw new Error("loadConfig succeeded");
  return err;
}

describe("skill improve keys (design 07-self-improvement, skill improvement)", () => {
  const KEYS = ["skill_improve_drop_margin", "skill_improve_stall_runs", "skill_improve_target", "skill_improve_noise", "skill_drafts_per_day", "skill_draft_token_budget"] as const;

  it("absent, startup succeeds and each takes its default", async () => {
    for (const k of KEYS) expect(SQLITE).not.toHaveProperty(k);
    await loadConfig(root(SQLITE));
    expect(skillImproveConfig({})).toEqual(SKILL_IMPROVE_DEFAULTS);
    expect(Object.keys(SKILL_IMPROVE_DEFAULTS).sort()).toEqual([...KEYS].sort());
  });

  it("loads the values set, at each bound", async () => {
    const set = { skill_improve_drop_margin: 0, skill_improve_noise: 1, skill_improve_target: 0.5, skill_improve_stall_runs: 1, skill_draft_token_budget: 1, skill_drafts_per_day: 0 };
    await loadConfig(root({ ...SQLITE, ...set }));
    expect(skillImproveConfig(set)).toEqual(set);
  });

  it("fails the config load on a wrong value, naming the key", async () => {
    const bad: [string, unknown][] = [
      ["skill_improve_drop_margin", -0.1], ["skill_improve_drop_margin", 1.5], ["skill_improve_drop_margin", "0.1"],
      ["skill_improve_noise", 2], ["skill_improve_noise", null], ["skill_improve_target", -1], ["skill_improve_target", "high"],
      ["skill_improve_stall_runs", 0], ["skill_improve_stall_runs", 2.5], ["skill_improve_stall_runs", "3"],
      ["skill_draft_token_budget", 0], ["skill_draft_token_budget", 1.5],
      ["skill_drafts_per_day", -1], ["skill_drafts_per_day", 0.5], ["skill_drafts_per_day", true],
    ];
    for (const [key, value] of bad) {
      const err = await loadError({ ...SQLITE, [key]: value });
      expect(err, `${key}=${JSON.stringify(value)}`).toBeInstanceOf(ConfigKeyError);
      expect(err.message).toContain(key);
      expect(() => skillImproveConfig({ [key]: value })).toThrow(key);
    }
  });
});
