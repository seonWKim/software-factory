import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentsHomeTacitLedger } from "../src/impl/tacit/agents-home-tacit-ledger.js";
import { parsePushbacks } from "../src/impl/tacit/ledger-text.js";
import { TacitRefusal } from "../src/interfaces/tacit-ledger.js";
import { stubHome, snapshot } from "./helpers/tacit-ledger-stub.js";

describe("plugin agents-home: pushbacks and dismiss", () => {
  it("pushbacks reads tacit show --active --unclustered: each row's ID, words and date; it writes nothing", async () => {
    const s = stubHome();
    writeFileSync(join(s.root, "pushbacks"), '# active, unclustered 2\n- T-0201 2026-11-20 — "keep the --json flag"\n- T-0202 — “두 줄 요약 먼저”\n');
    const before = snapshot(s.home);
    const ledger = new AgentsHomeTacitLedger(s.home);
    expect(await ledger.pushbacks()).toEqual([
      { id: "T-0201", pushback: "keep the --json flag", date: "2026-11-20" },
      { id: "T-0202", pushback: "두 줄 요약 먼저" },
    ]);
    expect(s.argv()).toEqual(["tacit|show|--active|--unclustered"]);
    expect(snapshot(s.home)).toEqual(before);
    rmSync(join(s.root, "pushbacks"));
    expect(await ledger.pushbacks()).toEqual([]);
  });

  it("text in another form, or a failed CLI, throws", async () => {
    expect(() => parsePushbacks('{"id":"T-1","pushback":"x"}\n')).toThrow(/no pushback row/);
    expect(parsePushbacks("# none\n\n")).toEqual([]);
    const s = stubHome();
    s.control("fail", true);
    await expect(new AgentsHomeTacitLedger(s.home).pushbacks()).rejects.toThrow(/^tacit show exited 3: ledger locked$/);
  });

  it("dismiss runs tacit status <T-id> noise, each value its own argv item; any other ID throws before a CLI runs", async () => {
    const s = stubHome();
    const ledger = new AgentsHomeTacitLedger(s.home);
    await ledger.dismiss("T-0201");
    expect(s.argv()).toEqual(["tacit|status|T-0201|noise"]);
    await expect(ledger.dismiss("C-012")).rejects.toBeInstanceOf(TacitRefusal);
    await expect(ledger.dismiss("T-1; touch pwned")).rejects.toBeInstanceOf(TacitRefusal);
    expect(s.argv()).toEqual(["tacit|status|T-0201|noise"]);
    s.control("refuse", true);
    await expect(ledger.dismiss("T-0201")).rejects.toThrow(/^tacit status exited 1: ledger locked$/);
  });
});

