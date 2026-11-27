import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentsHomeTacitLedger, agentsHome, checkAgentsHome, knownAgentsHomes, tacitLedgerAt } from "../src/impl/tacit/agents-home-tacit-ledger.js";
import { NoTacitLedger } from "../src/impl/tacit/no-tacit-ledger.js";
import { REGISTRY, createPlugin, defaultPlugins } from "../src/plugins.js";
import { issueRef } from "./helpers/fakes/config.js";
import { RULE, stubHome, SPEC_PENDING, harness, revise, verdict } from "./helpers/tacit-ledger-stub.js";

describe("plugin none (the default)", () => {
  it("is the default on every platform", () => {
    for (const platform of ["darwin", "linux", "win32"]) expect(defaultPlugins(platform).tacit).toBe("none");
  });

  it("captures nothing and enqueues no outbound intent", async () => {
    const none = await createPlugin(REGISTRY, "tacit", "none", {} as never);
    expect(none).toBeInstanceOf(NoTacitLedger);
    expect(none.enabled).toBe(false);
    expect(await none.pending()).toEqual([]);
    expect(await none.rules()).toEqual([]);
    await none.verdict("C-1", "promote", "why", RULE);
    for (const ledger of [none, undefined]) {
      const h = await harness(ledger);
      const it1 = await h.itemIn(issueRef(1), SPEC_PENDING, "the spec");
      await h.send(revise(1, "keep the flag"));
      expect((await h.get(it1)).version).toBeGreaterThan(it1.version);
      expect(await h.captureRows()).toEqual([]);
    }
  });
});

describe("plugin agents-home", () => {
  it("resolves its home from AGENTS_HOME, else ~/.agents", () => {
    expect(agentsHome({ AGENTS_HOME: "/x/agents" }, "/home/me")).toBe("/x/agents");
    expect(agentsHome({}, "/home/me")).toBe(join("/home/me", ".agents"));
    expect(agentsHome({ AGENTS_HOME: "  " }, "/home/me")).toBe(join("/home/me", ".agents"));
  });

  it("with no bin/tacit at the home path behaves as none, and building it does not fail", async () => {
    const empty = mkdtempSync(join(tmpdir(), "sf-tacit-empty-"));
    const ledger = tacitLedgerAt({ AGENTS_HOME: empty });
    expect(ledger).toBeInstanceOf(NoTacitLedger);
    const h = await harness(ledger);
    await h.itemIn(issueRef(1), SPEC_PENDING, "the spec");
    await h.send(revise(1, "keep the flag"));
    expect(await h.captureRows()).toEqual([]);
    expect(readdirSync(empty)).toEqual([]);
  });

  it("finds the home only when bin/tacit and bin/evolve are both executable files; else it names the first missing one", () => {
    const root = mkdtempSync(join(tmpdir(), "sf-tacit-detect-"));
    const at = join(root, "home");
    const check = () => checkAgentsHome({ AGENTS_HOME: at }, "/nowhere");
    expect(check()).toMatchObject({ path: at, missing: "bin/tacit" });
    mkdirSync(join(at, "bin"), { recursive: true });
    writeFileSync(join(at, "bin", "tacit"), "#!/bin/sh\n");
    expect(check().missing).toBe("bin/tacit"); // not executable
    chmodSync(join(at, "bin", "tacit"), 0o755);
    expect(check().missing).toBe("bin/evolve");
    mkdirSync(join(at, "bin", "evolve")); // a folder is no CLI
    expect(check().missing).toBe("bin/evolve");
    rmSync(join(at, "bin", "evolve"), { recursive: true });
    writeFileSync(join(at, "bin", "evolve"), "#!/bin/sh\n", { mode: 0o755 });
    expect(check()).toMatchObject({ path: at, missing: null });
    expect(tacitLedgerAt({ AGENTS_HOME: at }, "/nowhere")).toBeInstanceOf(AgentsHomeTacitLedger);
    // No AGENTS_HOME: ~/.agents under the given home.
    expect(checkAgentsHome({}, root)).toMatchObject({ path: join(root, ".agents"), missing: "bin/tacit" });
  });

  it("lists only the known homes, AGENTS_HOME when set and ~/.agents, each once, with its own check; the one in use stays AGENTS_HOME", () => {
    const root = mkdtempSync(join(tmpdir(), "sf-tacit-homes-"));
    const at = join(root, "set");
    const dflt = join(root, ".agents");
    for (const h of [at, dflt]) mkdirSync(join(h, "bin"), { recursive: true });
    for (const f of ["tacit", "evolve"]) writeFileSync(join(dflt, "bin", f), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(join(at, "bin", "tacit"), "#!/bin/sh\n", { mode: 0o755 });
    expect(knownAgentsHomes({ AGENTS_HOME: at }, root)).toEqual([at, dflt]);
    expect(knownAgentsHomes({}, root)).toEqual([dflt]);
    expect(knownAgentsHomes({ AGENTS_HOME: dflt }, root)).toEqual([dflt]);
    // Both results of the check: the first missing file, or none.
    expect(checkAgentsHome({ AGENTS_HOME: at }, root)).toEqual({
      path: at, missing: "bin/evolve", homes: [{ path: at, missing: "bin/evolve" }, { path: dflt, missing: null }],
    });
    expect(checkAgentsHome({}, root)).toEqual({ path: dflt, missing: null, homes: [{ path: dflt, missing: null }] });
    // A passing ~/.agents does not stand in for a broken AGENTS_HOME: the ledger stays off.
    expect(tacitLedgerAt({ AGENTS_HOME: at }, root)).toBeInstanceOf(NoTacitLedger);
  });

  it("is built from the stub home AGENTS_HOME names", () => {
    const s = stubHome();
    expect(tacitLedgerAt({ AGENTS_HOME: s.home })).toBeInstanceOf(AgentsHomeTacitLedger);
  });
});
