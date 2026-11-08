import { describe, expect, it } from "vitest";
import { Router } from "../../../src/controller/router/router.js";
import { defineUnit, type UnitDecision, type UnitDescriptor } from "../../../src/controller/router/unit.js";
import { tickAt, type Tick } from "../../../src/shared/ticks/tick-generator.js";

// The pure unit contract (RFC 0015 §6.2, §7): the router runs a pure unit's load through its reader, then decide on
// the tick, and commits the decision; a legacy step or event still runs as it is.

type Ev = { kind: "asked"; n: number };
type Reader = { double(n: number): Promise<number> };
type Write = { at: string; value: number };

function setup() {
  const committed: UnitDecision<Write>[] = [];
  const legacy: string[] = [];
  const pure = defineUnit<null, Ev, { seen: number }, Reader, Write>({
    name: "pure",
    create: () => ({ seen: 0 }),
    events: {
      asked: {
        load: (_u, e, r) => r.double(e.n),
        decide: (_u, _e, doubled: number, t) => ({ writes: [{ at: t.now, value: doubled }] }),
      },
    },
    steps: [{
      name: "count", every: "tick", order: 2,
      load: async (u) => u.seen + 1,
      decide: (u, next: number, t) => { u.seen = next; return { writes: [{ at: t.now, value: next }] }; },
    }],
  });
  const old = defineUnit<null, Ev, null, Reader, Write>({
    name: "old",
    create: () => null,
    steps: [{ name: "legacy", every: "tick", order: 1, run: async () => void legacy.push("ran") }],
  });
  const event: Tick = tickAt("event", 1, Date.parse("2026-01-01T00:00:00Z"));
  // Discovery hands the router its units with their operations unknown, as here.
  const units = [pure, old] as unknown as UnitDescriptor<null, Ev, unknown, Reader, Write>[];
  const r = new Router<null, Ev, Reader, Write>(units, null, {
    guard: (_what, fn) => fn(),
    reader: { double: async (n) => n * 2 },
    commit: async (d) => void committed.push(d),
    now: () => event,
  });
  return { r, committed, legacy };
}

describe("router: pure units", () => {
  it("loads through the reader, decides on the tick and commits the decision; a legacy step runs as before", async () => {
    const { r, committed, legacy } = setup();
    await r.dispatch({ kind: "asked", n: 21 });
    const t = tickAt("decide", 1, Date.parse("2026-01-02T00:00:00Z"));
    await r.tick(["tick"], t);
    await r.step("count", t);
    expect(legacy).toEqual(["ran"]);
    expect(committed).toEqual([
      { writes: [{ at: "2026-01-01T00:00:00.000Z", value: 42 }] },
      { writes: [{ at: t.now, value: 1 }] },
      { writes: [{ at: t.now, value: 2 }] },
    ]);
  });

  it("refuses a step name it does not have", async () => {
    await expect(setup().r.step("nope", tickAt("x", 1, 0))).rejects.toThrow(/no controller step "nope"/);
  });
});
