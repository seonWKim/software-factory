import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// docs/design/03-risk.md (decision of 2026-11-07): every src file that reads a credential sits under a tier-4
// floor in the checked factory.config.json, or is on EXEMPT below with a reason. A change to a credential
// reader then always needs the owner's merge. The floors come from the checked config, never from a fake.

const ROOT = join(import.meta.dirname, "..");
const SRC = join(ROOT, "src");
const CREDENTIAL_TIER = 4;

type Floor = { prefix: string; tier: number };
const FLOORS = (JSON.parse(readFileSync(join(ROOT, "factory.config.json"), "utf8")) as { floors: Floor[] }).floors;

/**
 * Reviewed exceptions: files that touch the SecretStore interface or name a secret but are not under a
 * tier-4 floor. Each needs a reason. "follow-up" entries read secret values and are waiting for the task
 * that floors the other secret readers; remove each one when its floor lands.
 */
const EXEMPT: Record<string, string> = {
  "src/interfaces/secret-store.ts": "defines the SecretStore type and secretName(); holds and reads no value",
  "src/plugin-api.ts": "types only: passes the SecretStore into plugin contexts and declares secret names",
  "src/compose.ts": "wiring only: builds the SecretStore plugin and hands it to other plugins; reads no value",
  "src/golden.ts": "wiring only: hands the SecretStore to the runner for golden runs; reads no value",
  "src/impl/claude/claude-shared.ts": "declares the Claude secret names for the plugin descriptors; reads no value",
  "src/impl/llm/claude-cli-llm-provider.ts": "follow-up: reads the Claude model credential",
  "src/impl/llm/openai-compatible-llm-provider.ts": "follow-up: reads OPENAI_COMPATIBLE_API_KEY",
  "src/impl/source/slack-api.ts": "follow-up: reads the Slack bot and app tokens",
  "src/impl/store/mysql/mysql.plugin.ts": "follow-up: reads MYSQL_PASSWORD",
  "src/impl/test-database/mysql-local.plugin.ts": "follow-up: reads TEST_MYSQL_URL",
  "src/main.ts": "follow-up: reads MYSQL_PASSWORD and names secrets to rotate",
  "src/setup.ts": "follow-up: writes and checks secrets during setup",
};

type SourceFile = { path: string; text: string };

function srcFiles(dir: string): SourceFile[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return srcFiles(full);
    if (!/\.tsx?$/.test(e.name)) return [];
    return [{ path: relative(ROOT, full).split("\\").join("/"), text: readFileSync(full, "utf8") }];
  });
}

/** Imports the SecretStore interface module, or names a secret with secretName(). */
function readsCredentials(text: string): boolean {
  return /from\s+["'][^"']*interfaces\/secret-store(?:\.js)?["']/.test(text) || /\bsecretName\(/.test(text);
}

/** Same rule as the diff gate: a floor is a path prefix. */
function floored(path: string, floors: readonly Floor[]): boolean {
  return floors.some((f) => f.tier >= CREDENTIAL_TIER && path.startsWith(f.prefix));
}

function unflooredReaders(files: readonly SourceFile[], floors: readonly Floor[], exempt: Record<string, string>): string[] {
  return files.filter((f) => readsCredentials(f.text) && !floored(f.path, floors) && !(f.path in exempt)).map((f) => f.path);
}

const FILES = srcFiles(SRC);

describe("credential readers sit under a tier-4 floor (docs/design/03-risk.md)", () => {
  it("the two GitHub credential files have their own tier-4 file floor", () => {
    for (const file of ["src/impl/github/app-credentials.ts", "src/impl/github/token-credentials.ts"]) {
      expect(FLOORS).toContainEqual({ prefix: file, tier: CREDENTIAL_TIER });
    }
  });

  it("no floor covers the whole src/impl/github/ folder", () => {
    expect(FLOORS.filter((f) => "src/impl/github/".startsWith(f.prefix))).toEqual([]);
  });

  it("every src file that reads credentials is floored at tier 4 or exempt with a reason", () => {
    expect(unflooredReaders(FILES, FLOORS, EXEMPT)).toEqual([]);
  });

  it("each exempt entry has a reason, still reads credentials and is not floored", () => {
    const byPath = new Map(FILES.map((f) => [f.path, f.text]));
    for (const [path, reason] of Object.entries(EXEMPT)) {
      expect(reason.trim(), path).not.toBe("");
      const text = byPath.get(path);
      expect(text, `${path} no longer exists: remove it from EXEMPT`).toBeDefined();
      expect(readsCredentials(text!), `${path} no longer reads credentials: remove it from EXEMPT`).toBe(true);
      expect(floored(path, FLOORS), `${path} is floored now: remove it from EXEMPT`).toBe(false);
    }
  });

  it("a credential-reading file added outside the floors fails the check", () => {
    const added: SourceFile[] = [
      { path: "src/impl/github/new-credentials.ts", text: 'import type { SecretStore } from "../../interfaces/secret-store.js";\n' },
      { path: "src/impl/other/reader.ts", text: 'const KEY = secretName("SOME_KEY");\n' },
      { path: "src/impl/other/plain.ts", text: "export const x = 1;\n" },
    ];
    expect(unflooredReaders([...FILES, ...added], FLOORS, EXEMPT)).toEqual([
      "src/impl/github/new-credentials.ts",
      "src/impl/other/reader.ts",
    ]);
  });
});
