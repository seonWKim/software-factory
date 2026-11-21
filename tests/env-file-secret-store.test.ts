// The env-file SecretStore reads its file again when a declared name has no value (design §5 Restarts, setup
// state): a credential added while the factory runs is found with no restart, and the egress scanner looks for it.
// Temp files only: never the owner's secret file.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EnvFileSecretStore, RELOAD_MS } from "../src/impl/secrets/env-file-secret-store.js";
import { secretName } from "../src/interfaces/secret-store.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const TOKEN = secretName("CLAUDE_CODE_OAUTH_TOKEN");
const OTHER = secretName("GITHUB_TOKEN");
/** Secret-like values built from parts, so no literal credential sits in the repository. */
const value = (tag: string) => ["sk", "ant", tag, "z".repeat(24)].join("-");

function store(text: string | null) {
  const dir = mkdtempSync(join(tmpdir(), "sf-env-reload-"));
  dirs.push(dir);
  const file = join(dir, ".env");
  if (text !== null) writeFileSync(file, text, { mode: 0o600 });
  let now = 1_000_000;
  const s = new EnvFileSecretStore(file, [TOKEN, OTHER], [], () => now);
  return { s, file, advance: (ms: number) => void (now += ms) };
}

describe("EnvFileSecretStore: a value added while the factory runs", () => {
  // Bug: the file is read once per process, so `npm run setup` while `factory dev` runs changes nothing until a restart.
  it("a declared name with no value is read again once RELOAD_MS passed, and the scanner then holds the new value", async () => {
    const { s, file, advance } = store("");
    expect(await s.get(TOKEN)).toBeNull();
    writeFileSync(file, `CLAUDE_CODE_OAUTH_TOKEN=${value("oat01")}\n`);
    advance(RELOAD_MS - 1);
    expect(await s.get(TOKEN)).toBeNull(); // at most one read per RELOAD_MS: a check every tick costs no file read
    advance(1);
    expect((await s.get(TOKEN))?.reveal()).toBe(value("oat01"));
    expect(await s.valuesForScan()).toContain(value("oat01"));
  });

  // Bug: a failed first read (no file yet) is kept for good, so every later get throws.
  it("a missing file is read again once RELOAD_MS passed", async () => {
    const { s, file, advance } = store(null);
    await expect(s.get(TOKEN)).rejects.toThrow("secret file not found");
    writeFileSync(file, `CLAUDE_CODE_OAUTH_TOKEN=${value("oat01")}\n`, { mode: 0o600 });
    advance(RELOAD_MS);
    expect((await s.get(TOKEN))?.reveal()).toBe(value("oat01"));
  });

  // Bug: a re-read drops a value from the scan, so a secret a run already holds can leave in its output.
  it("a value removed from the file stays in the scan", async () => {
    const { s, file, advance } = store(`GITHUB_TOKEN=${value("gh")}\n`);
    expect(await s.valuesForScan()).toContain(value("gh"));
    writeFileSync(file, "");
    advance(RELOAD_MS);
    expect(await s.get(TOKEN)).toBeNull(); // a miss reads the file again: GITHUB_TOKEN is gone from it now
    expect(await s.get(OTHER)).toBeNull();
    expect(await s.valuesForScan()).toContain(value("gh"));
  });
});
