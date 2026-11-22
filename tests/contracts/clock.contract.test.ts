import { describe } from "vitest";
import { FakeClock } from "../../src/impl/clock/fake-clock.js";
import { SystemClock } from "../../src/impl/clock/system-clock.js";
import { type ClockUnderTest, clockContract } from "./clock.contract.js";

const IMPLEMENTATIONS: { name: string; make: () => ClockUnderTest }[] = [
  {
    name: "SystemClock",
    make: () => ({ clock: new SystemClock(), pass: (ms) => new Promise((r) => setTimeout(r, ms)) }),
  },
  {
    name: "FakeClock",
    make: () => {
      const clock = new FakeClock();
      return { clock, pass: async (ms) => clock.advance(ms) };
    },
  },
];

describe.each(IMPLEMENTATIONS)("Clock contract: $name", ({ make }) => {
  clockContract(make);
});
