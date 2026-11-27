// The command table against the API registry (split from command-table.test.ts, no test changed).

import { describe, expect, it } from "vitest";
import { COMMAND_TABLE, SENTENCE_FORM } from "../src/core/command-table.js";
import { REGISTRY } from "../src/api/index.js";

/** The capability an entry maps to: `<noun> <verb>` is `<noun>s.<verb>` (`schedule list` is `schedules.list`). */
const capabilityOf = (name: string): string | null => {
  const [noun, ...verb] = name.split(" ");
  return verb.length === 0 ? null : `${noun}s.${verb.join("-")}`;
};

/** The command-table entries with no capability yet (design 09-api-registry): each moves off this list when declared. */
const NO_CAPABILITY: readonly string[] = [
  "task create", "task add", "task done", "task reopen", "task edit", "task delete", "task sub", "task build", "task list", "task project",
  "project create", "project list", "project rename", "project archive", "project restore", "project delete", "task show",
  "approve", "retry", "revise", "reject", "resolve", "task paths", "task note", "hold", "verdict", "merge", "run-next", SENTENCE_FORM, "confirm",
  "settings list", "settings set", "settings reset", "settings history", "mode",
];

describe("the command table and the API registry", () => {
  const ids = new Set(REGISTRY.capabilities.map((c) => c.id));
  const declared = (name: string) => { const id = capabilityOf(name); return id !== null && ids.has(id); };

  it("every entry has a capability (`schedule <verb>` is `schedules.<verb>`) or is on the exceptions list", () => {
    for (const c of COMMAND_TABLE) expect({ name: c.name, ok: declared(c.name) || NO_CAPABILITY.includes(c.name) }).toEqual({ name: c.name, ok: true });
    for (const c of COMMAND_TABLE.filter((x) => x.group === "schedule")) expect(declared(c.name), c.name).toBe(true);
  });

  it("the exceptions list names only table entries with no capability", () => {
    const names = COMMAND_TABLE.map((c) => c.name);
    for (const n of NO_CAPABILITY) expect({ n, entry: names.includes(n), capability: declared(n) }).toEqual({ n, entry: true, capability: false });
  });
});
