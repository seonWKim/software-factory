import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TRIAGE_CHECK_KINDS } from "../src/controller/golden-gate/triage-replay.js";
import { type GenDeps, type GenLlm, TRIAGE_PERSONAS, genTriageDrafts, parseGenArgs } from "../src/controller/golden-gate/triage-gen.js";
import { cleanScanner } from "./helpers/fakes/config.js";

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "sf-triage-gen-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const ITEM = "wi_closed1";
const SPEC = "# Work item wi_closed1\n\n## Problem\n\nThe digest skips empty days.\n";

/** A fake LLMProvider: records each request and answers a persona draft; no live call. */
class FakeLlm implements GenLlm {
  calls: Parameters<GenLlm["complete"]>[0][] = [];
  constructor(private readonly answer: (n: number) => { text: string; parsed?: unknown; stop_reason: string } = (n) => ({
    text: "", stop_reason: "end",
    parsed: { instruction: `Request ${n}: fix the digest`, checks: [{ kind: "no_question" }, { kind: "names_paths", paths: ["src/digest/run.ts"] }] },
  })) {}
  async complete(req: Parameters<GenLlm["complete"]>[0]) {
    this.calls.push(req);
    return this.answer(this.calls.length);
  }
}

function deps(over: Partial<GenDeps> = {}, stage = "CLOSED"): GenDeps & { llm: FakeLlm } {
  return { item: async (id) => (id === ITEM ? { stage, spec: SPEC } : null), llm: new FakeLlm(), scanner: cleanScanner, draftsDir: join(tmp, "golden", "drafts", "triage"), ...over } as GenDeps & { llm: FakeLlm };
}

const draftDir = (d: GenDeps) => join(d.draftsDir, ITEM);

describe("golden gen role/triage", () => {
  it("writes one draft per persona from a closed item, with one LLM call each (data_env test)", async () => {
    const d = deps();
    const r = await genTriageDrafts(d, { from: ITEM, force: false });
    expect(r.dir).toBe(draftDir(d));
    expect(d.llm.calls).toHaveLength(TRIAGE_PERSONAS.length);
    expect(TRIAGE_PERSONAS).toHaveLength(6);
    for (const [i, call] of d.llm.calls.entries()) {
      expect(call.data_env).toBe("test");
      expect(call.messages[0]!.content).toContain(TRIAGE_PERSONAS[i]!.name);
      expect(call.messages[0]!.content).toContain(SPEC);
    }
    expect((await readdir(draftDir(d))).sort()).toEqual(TRIAGE_PERSONAS.map((p) => p.name).sort());
    for (const p of TRIAGE_PERSONAS) {
      const dir = join(draftDir(d), p.name);
      expect(await readFile(join(dir, "instruction.md"), "utf8")).toMatch(/^Request \d: fix the digest\n$/);
      const kase = JSON.parse(await readFile(join(dir, "case.json"), "utf8"));
      expect(kase.expect).toBe("should_pass");
      expect(kase.uses).toEqual(["prompt:triage.md"]);
      expect(kase.checks).toEqual([{ kind: "no_question" }, { kind: "names_paths", paths: ["src/digest/run.ts"] }]);
      for (const c of kase.checks) expect(TRIAGE_CHECK_KINDS).toContain(c.kind);
    }
  });

  it("refuses an item that is not CLOSED, with no LLM call and no file written", async () => {
    const d = deps({}, "IMPLEMENTING");
    await expect(genTriageDrafts(d, { from: ITEM, force: false })).rejects.toThrow(/IMPLEMENTING, not CLOSED/);
    expect(d.llm.calls).toEqual([]);
    expect(existsSync(d.draftsDir)).toBe(false);
  });

  it("refuses an unknown item with no LLM call", async () => {
    const d = deps();
    await expect(genTriageDrafts(d, { from: "wi_none", force: false })).rejects.toThrow(/no work item wi_none/);
    expect(d.llm.calls).toEqual([]);
  });

  it("scans every draft (channel commit) before writing; a finding writes nothing and names rules only", async () => {
    const secret = `ghp_${"A".repeat(36)}`;
    const channels: string[] = [];
    const scanner: GenDeps["scanner"] = {
      async scan(channel, content) {
        channels.push(channel);
        return content.includes(secret) ? { clean: false, findings: [{ rule: "github_token" }] } : { clean: true };
      },
    };
    const llm = new FakeLlm((n) => ({ text: "", stop_reason: "end", parsed: { instruction: n === 6 ? `token ${secret}` : "fine", checks: [{ kind: "no_question" }] } }));
    const d = deps({ scanner, llm });
    const err = await genTriageDrafts(d, { from: ITEM, force: false }).then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/nothing written\): github_token$/);
    expect(err?.message).not.toContain(secret);
    expect(llm.calls).toHaveLength(6);
    expect(channels.length).toBeGreaterThanOrEqual(12);
    expect(new Set(channels)).toEqual(new Set(["commit"]));
    expect(existsSync(d.draftsDir) && (await readdir(d.draftsDir)).length > 0).toBe(false);
  });

  it("a bad answer (unknown check kind, early stop) writes nothing", async () => {
    const bad = deps({ llm: new FakeLlm(() => ({ text: "", stop_reason: "end", parsed: { instruction: "x", checks: [{ kind: "guess" }] } })) });
    await expect(genTriageDrafts(bad, { from: ITEM, force: false })).rejects.toThrow(/unknown kind/);
    const cut = deps({ llm: new FakeLlm(() => ({ text: "{", stop_reason: "max_tokens" })) });
    await expect(genTriageDrafts(cut, { from: ITEM, force: false })).rejects.toThrow(/stopped early/);
    expect(existsSync(draftDir(bad))).toBe(false);
  });

  it("reads a JSON text answer when the provider gives no parsed value", async () => {
    const d = deps({ llm: new FakeLlm(() => ({ text: JSON.stringify({ instruction: "t", checks: [{ kind: "splits" }] }), stop_reason: "end" })) });
    await genTriageDrafts(d, { from: ITEM, force: false });
    expect(JSON.parse(await readFile(join(draftDir(d), "planner", "case.json"), "utf8")).checks).toEqual([{ kind: "splits" }]);
  });

  it("refuses existing drafts without --force and replaces them with it", async () => {
    const d = deps();
    await genTriageDrafts(d, { from: ITEM, force: false });
    const again = deps();
    await expect(genTriageDrafts(again, { from: ITEM, force: false })).rejects.toThrow(/already exist/);
    expect(again.llm.calls).toEqual([]);
    await genTriageDrafts(again, { from: ITEM, force: true });
    expect(again.llm.calls).toHaveLength(6);
  });

  it("parses role/triage --from <id>, and refuses other roles and a missing or unsafe id", () => {
    expect(parseGenArgs(["role/triage", "--from", ITEM])).toEqual({ from: ITEM, force: false });
    expect(parseGenArgs(["--from", ITEM, "role/triage", "--force"])).toEqual({ from: ITEM, force: true });
    expect(() => parseGenArgs(["role/review", "--from", ITEM])).toThrow(/triage cases only/);
    expect(() => parseGenArgs(["role/triage"])).toThrow(/usage/);
    expect(() => parseGenArgs(["role/triage", "--from", "../x"])).toThrow(/usage/);
  });
});
