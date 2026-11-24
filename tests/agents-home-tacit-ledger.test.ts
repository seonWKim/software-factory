// The agents-home plugin's skill hand-off (docs/plugins/tacit-ledger.md, design 07-self-improvement): `changeProposal`
// runs `evolve propose --id …` and `verdictRecord` runs `evolve verdict <id> …`, each value its own argv item, no stdin,
// nothing written under the home. Every test runs a stub `bin/evolve` in a temp home: no real home, no live CLI.

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentsHomeTacitLedger } from "../src/impl/tacit/agents-home-tacit-ledger.js";
import { NoTacitLedger } from "../src/impl/tacit/no-tacit-ledger.js";
import { type TacitChangeProposal, type TacitLedger, TacitRefusal } from "../src/interfaces/tacit-ledger.js";

/**
 * A temp home whose `bin/tacit` and `bin/evolve` log their argv outside the home (each item ended by \x1f, each call
 * by \x1e, so a value may hold a line break); `fail` makes each exit 3.
 */
function stubHome(o: { fail?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "sf-tacit-skill-"));
  const home = join(root, "home");
  mkdirSync(join(home, "bin"), { recursive: true });
  const script = (name: string) => `#!/bin/sh
{ printf '%s\\037' "${name}"; for a in "$@"; do printf '%s\\037' "$a"; done; printf '\\036'; } >> "${root}/argv"
[ -z "$(cat)" ] || { echo "unexpected stdin" >&2; exit 4; }
${o.fail ? `echo "ledger locked" >&2; exit 3` : "true"}
`;
  for (const cli of ["tacit", "evolve"]) {
    writeFileSync(join(home, "bin", cli), script(cli));
    chmodSync(join(home, "bin", cli), 0o755);
  }
  const argv = () => {
    try {
      return readFileSync(join(root, "argv"), "utf8").split("\x1e").filter((c) => c !== "").map((c) => c.split("\x1f").slice(0, -1));
    } catch {
      return [];
    }
  };
  return { home, argv, files: () => readdirSync(home).sort() };
}

const PROPOSAL: TacitChangeProposal = {
  id: "skd_abc123", target: "skills/a/SKILL.md", title: "Improve skills/a: pass rate 0.5 → 0.9",
  rationale: "It failed: cites the source; \"quoted\" $(not run)", change: "# Skill A\n\nNew text with `ticks` and $HOME.",
};

describe("the skill hand-off methods", () => {
  it("are optional on the interface: the none plugin omits both, the agents-home plugin has both", () => {
    const none: TacitLedger = new NoTacitLedger();
    expect(none.enabled).toBe(false);
    expect(none.changeProposal).toBeUndefined();
    expect(none.verdictRecord).toBeUndefined();
    const on: TacitLedger = new AgentsHomeTacitLedger(stubHome().home);
    expect(typeof on.changeProposal).toBe("function");
    expect(typeof on.verdictRecord).toBe("function");
  });

  it("changeProposal runs evolve propose with each field its own argv item and nothing on stdin", async () => {
    const s = stubHome();
    await new AgentsHomeTacitLedger(s.home).changeProposal(PROPOSAL);
    expect(s.argv()).toEqual([[
      "evolve", "propose", "--id", PROPOSAL.id, "--kind", "edit-asset", "--target", PROPOSAL.target, "--title", PROPOSAL.title,
      "--rationale", PROPOSAL.rationale, "--change", PROPOSAL.change,
    ]]);
    expect(s.files()).toEqual(["bin"]);
  });

  it("verdictRecord runs evolve verdict with a reason, and --applied-to the target on promote only", async () => {
    const s = stubHome();
    const l = new AgentsHomeTacitLedger(s.home);
    for (const decision of ["hold", "reject", "promote"] as const) await l.verdictRecord({ id: "skd_abc123", decision, target: "skills/a/SKILL.md", reason: "the owner's verdict" });
    expect(s.argv()).toEqual([
      ["evolve", "verdict", "skd_abc123", "hold", "--reason", "the owner's verdict"],
      ["evolve", "verdict", "skd_abc123", "reject", "--reason", "the owner's verdict"],
      ["evolve", "verdict", "skd_abc123", "promote", "--reason", "the owner's verdict", "--applied-to", "skills/a/SKILL.md"],
    ]);
    expect(s.files()).toEqual(["bin"]);
  });

  it("an ID that could be read as a flag is refused before any CLI runs", async () => {
    const s = stubHome();
    const l = new AgentsHomeTacitLedger(s.home);
    await expect(l.changeProposal({ ...PROPOSAL, id: "--help" })).rejects.toBeInstanceOf(TacitRefusal);
    await expect(l.verdictRecord({ id: "-x", decision: "hold", target: "t", reason: "r" })).rejects.toBeInstanceOf(TacitRefusal);
    await expect(l.verdictRecord({ id: "a b", decision: "hold", target: "t", reason: "r" })).rejects.toBeInstanceOf(TacitRefusal);
    expect(s.argv()).toEqual([]);
  });

  it("a CLI failure throws the CLI's error, for the caller to log", async () => {
    const s = stubHome({ fail: true });
    const l = new AgentsHomeTacitLedger(s.home);
    await expect(l.changeProposal(PROPOSAL)).rejects.toThrow("evolve propose exited 3: ledger locked");
    await expect(l.verdictRecord({ id: "skd_abc123", decision: "reject", target: "t", reason: "r" })).rejects.toThrow("evolve verdict exited 3: ledger locked");
  });
});
