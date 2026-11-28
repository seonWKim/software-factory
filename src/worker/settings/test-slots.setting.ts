// Host test slots (phase 1 of 3 of local-28caa30d): how many full test runs may run at once on one host, counted
// across every worker process in worker_test_slots. Settable at runtime (`factory settings set`). It has no fixed
// default: absent, the cap follows the host's cores (testSlotCap), so a bigger host runs more at once.

import { defineSetting } from "../../shared/setting.js";

/** The cap: a set value as given; absent, a quarter of `cpus` (the host's available parallelism), at least 1. */
export function testSlotCap(value: number | null | undefined, cpus: number): number {
  return value ?? Math.max(1, Math.floor(cpus / 4));
}

export default defineSetting<number>({
  key: "test_slots",
  owner: "worker",
  type: "integer",
  default: null,
  description: "Most full test runs at once on one host. None: a quarter of the host's cores, at least 1.",
  applies: "the next test slot a run takes",
  direction: "free",
  changed_by: "runtime",
  scope: "global",
});
