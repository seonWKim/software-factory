import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { ACTOR_FILE, type ActorDescriptor, actorProblems } from "../../src/controller/router/actor.js";
import { findDescriptorFiles } from "../../src/state/index.js";
import { SRC } from "./lib.js";

// RFC 0015 §9 state-machines: every actor has a state table, and the table is sound (known states, nothing
// leaves a terminal state, every state reachable from an initial one).

async function actors(): Promise<ActorDescriptor[]> {
  return Promise.all(
    findDescriptorFiles(SRC, ACTOR_FILE).map(async (f) => ((await import(pathToFileURL(f).href)) as { default: ActorDescriptor }).default),
  );
}

describe("state-machines", () => {
  it("every actor table is sound", async () => {
    const all = await actors();
    expect(all.map((a) => a.name)).toContain("WorkItem");
    for (const a of all) expect(actorProblems(a), a.name).toEqual([]);
  });

  it("catches an unreachable state and a move out of a terminal state", () => {
    const bad: ActorDescriptor = { kind: "actor", name: "X", states: ["A", "B", "Z"], initial: ["A"], terminal: ["B"], transitions: [["A", "B"], ["B", "A"]] };
    expect(actorProblems(bad)).toEqual(["X: B is terminal but moves to A", "X: Z is never reached"]);
  });
});
