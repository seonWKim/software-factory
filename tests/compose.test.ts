// The dashboard process builds the skill wiring (design 09-dashboard-rules-waiting): compose.ts buildUiParts returns
// it for the UI deps with the core verdicts, so Promote runs from the Rules page; without capabilities.skill_folders there is no wiring.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildUiParts } from "../src/compose.js";
import type { CliIdentity } from "../src/core/local-cli.js";
import { holdSkillDraft, promoteSkillDraft, rejectSkillDraft } from "../src/core/skill-improve.js";
import type { UserId } from "../src/core/types.js";
import { type Loaded, loadConfig } from "../src/load-config.js";

const REAL = JSON.parse(readFileSync(join(import.meta.dirname, "..", "factory.config.json"), "utf8")) as Record<string, unknown>;
const ME: CliIdentity = { user: "local:me@example.com" as UserId, from: "git user.email" };

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A throwaway repo root with the real config on SQLite, its prompts, a secret file and `capabilities` when given. */
async function loaded(capabilities?: Record<string, unknown>): Promise<Loaded> {
  const dir = mkdtempSync(join(tmpdir(), "sf-ui-skill-"));
  mkdirSync(join(dir, "prompts"));
  for (const p of ["triage", "implement", "review"]) writeFileSync(join(dir, "prompts", `${p}.md`), p);
  mkdirSync(join(dir, "skills", "a"), { recursive: true });
  writeFileSync(join(dir, "factory.config.json"), JSON.stringify({ ...REAL, store: { type: "sqlite" }, ...(capabilities ? { capabilities } : {}) }));
  mkdirSync(join(dir, "secrets"));
  writeFileSync(join(dir, "secrets", ".env"), "MYSQL_PASSWORD=pw\nGITHUB_TOKEN=gh\n");
  vi.stubEnv("SOFTWARE_FACTORY_SECRETS_FILE", join(dir, "secrets", ".env"));
  return loadConfig(dir);
}

describe("buildUiParts: the skill verdicts and wiring", () => {
  it("is built over capabilities.skill_folders, so Promote can run in the dashboard process", async () => {
    const l = await loaded({ skill_folders: ["skills"] });
    const parts = await buildUiParts(l, { identity: ME });
    try {
      const w = parts.skillImprove.wiring;
      expect(w).toBeDefined();
      expect(w!.skill_folders).toEqual([join(l.root, "skills")]);
      expect(w!.folderOf("skills/a")).toBe(join(l.root, "skills", "a"));
      // The verdicts are the core's own functions, the ones the CLI verb runs too.
      expect(parts.skillImprove).toMatchObject({ hold: holdSkillDraft, reject: rejectSkillDraft, promote: promoteSkillDraft });
    } finally {
      await parts.close();
    }
  });

  it("has no wiring without capabilities.skill_folders (Promote is refused; hold and reject still run)", async () => {
    const parts = await buildUiParts(await loaded(), { identity: ME });
    try {
      expect(parts.skillImprove.wiring).toBeUndefined();
    } finally {
      await parts.close();
    }
  });

  it("builds the starter drafts with the Model plugin and prompts/skill-starter.md, with or without skill_folders (design 07)", async () => {
    const l = await loaded();
    const parts = await buildUiParts(l, { identity: ME });
    try {
      expect(await parts.starter.unavailable()).toMatch(/^prompts\/skill-starter\.md cannot be read/);
      writeFileSync(join(l.codeRoot, "prompts", "skill-starter.md"), "starter");
      expect(await parts.starter.unavailable()).toBeNull();
      expect(await parts.starter.draft("skills/none", new AbortController().signal)).toEqual({ refused: "skills/none/SKILL.md cannot be read, so nothing was drafted." });
    } finally {
      await parts.close();
    }
  });
});
