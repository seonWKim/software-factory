// The hotspot cut (design 07-self-improvement): per file, the conflict runs and held decisions recorded before the
// last merge that halved it (deleted at least half of its lines) are not counted. Pure: no store, no git.

import { describe, expect, it } from "vitest";
import { HOTSPOT, type MergeGit, halvingCuts, hotspotBody, hotspotGroups } from "../src/core/hotspots.js";
import type { ClaimDecision, Run, RunOutcome, Timestamp } from "../src/core/types.js";

const FILE = "src/worker/runner.ts";
const OTHER = "docs/design/09-dashboard-app.md";
const at = (h: number) => `2026-11-18T${String(h).padStart(2, "0")}:00:00.000Z` as Timestamp;
const conflict = (id: string, h: number, files = [FILE]): Run =>
  ({ id, kind: "implement", work_item_id: `wi_${id}`, finished_at: at(h), outcome: { status: "failed", error_code: "merge_conflict", detail: "", infra: false, conflicts: files } as RunOutcome }) as unknown as Run;
const held = (item: string, h: number, paths = [FILE]): ClaimDecision =>
  ({ work_item_id: item, decision: "held", at: at(h), shared: paths.map((path) => ({ path, weight: 3, conflicts: 0, hotspot: true })) }) as unknown as ClaimDecision;

describe("hotspotGroups: the halving cut", () => {
  const runs = [conflict("r1", 1), conflict("r2", 2, [FILE, OTHER]), conflict("r3", 5), conflict("r4", 6)];
  const decisions = [held("wi_h1", 3), held("wi_h2", 7), held("wi_h1", 8)];

  it("drops a file's runs and holds recorded before its cut; later ones still count; other files are not cut", () => {
    const [row] = hotspotGroups(runs, decisions, 1, new Map([[FILE, at(4)]])).filter((g) => g.detail === FILE);
    expect(row).toMatchObject({ error_code: HOTSPOT, run_ids: ["r3", "r4"], held_item_ids: ["wi_h2", "wi_h1"] });
    expect(row!.counted_at).toEqual({ r3: at(5), r4: at(6), wi_h2: at(7), wi_h1: at(8) });
    expect(hotspotGroups(runs, decisions, 1, new Map([[FILE, at(4)]])).find((g) => g.detail === OTHER)!.run_ids).toEqual(["r2"]);
  });

  it("a run at the cut's exact time counts; below the threshold after the cut, no row", () => {
    expect(hotspotGroups(runs, [], 3, new Map([[FILE, at(5)]])).filter((g) => g.detail === FILE)).toEqual([]);
    expect(hotspotGroups(runs, [], 2, new Map([[FILE, at(5)]])).find((g) => g.detail === FILE)!.run_ids).toEqual(["r3", "r4"]);
  });

  it("with three arguments, nothing is cut", () => {
    const [row] = hotspotGroups(runs, decisions, 1);
    expect(row).toMatchObject({ detail: FILE, run_ids: ["r1", "r2", "r3", "r4"], held_item_ids: ["wi_h1", "wi_h2"] });
    expect(row!.counted_at!.wi_h1).toBe(at(3));
  });

  it("the body names each counted run and held item with its date", () => {
    const [row] = hotspotGroups(runs, decisions, 1, new Map([[FILE, at(4)]]));
    const body = hotspotBody(row!);
    expect(body).toContain(`\`r3\` (${at(5)})`);
    expect(body).toContain(`\`wi_h2\` (${at(7)})`);
    expect(body).not.toContain("`r1`");
  });
});

describe("halvingCuts", () => {
  const git = (bySha: Record<string, Record<string, { deleted: number; lines: number }>>): MergeGit => ({
    removals: async (sha) => new Map(Object.entries(bySha[sha] ?? {})),
    existsAtHead: async () => true,
  });

  it("cuts a file at the last merge that deleted at least half of its lines", async () => {
    const cuts = await halvingCuts(
      git({ a: { [FILE]: { deleted: 5, lines: 10 } }, b: { [FILE]: { deleted: 4, lines: 10 }, [OTHER]: { deleted: 3, lines: 3 } }, c: { [FILE]: { deleted: 6, lines: 6 } } }),
      [{ merge_sha: "a", merged_at: at(1) }, { merge_sha: "b", merged_at: at(2) }, { merge_sha: "c", merged_at: at(3) }],
    );
    expect(cuts.get(FILE)).toBe(at(3));
    expect(cuts.get(OTHER)).toBe(at(2));
  });

  it("a merge deleting less than half, or from an empty file, cuts nothing", async () => {
    const cuts = await halvingCuts(git({ a: { [FILE]: { deleted: 4, lines: 9 }, [OTHER]: { deleted: 0, lines: 0 } } }), [{ merge_sha: "a", merged_at: at(1) }]);
    expect([...cuts]).toEqual([]);
  });

  it("a git failure is not swallowed", async () => {
    const failing: MergeGit = { removals: async () => { throw new Error("git diff failed"); }, existsAtHead: async () => true };
    await expect(halvingCuts(failing, [{ merge_sha: "a", merged_at: at(1) }])).rejects.toThrow("git diff failed");
  });
});
