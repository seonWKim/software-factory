import { describe, expect, it } from "vitest";
import { givenValues, missingValues, specText } from "../src/core/given-values.js";
import { parseTriage } from "../src/core/outputs.js";
import { renderSpec } from "../src/core/spec-comment.js";
import { LiveSettings, baseFromConfig } from "../src/core/settings.js";
import type { WorkItem, WorkerId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import type { SourceEvent } from "../src/interfaces/source-adapter.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { FakeAuth, FakeForge, FakeSource, alice, cleanScanner, config, issueRef, pipeline, silent, triageSpec } from "./helpers/fakes.js";
import { newStore } from "./helpers/store.js";

// Given values (design 04-agents.md): a request's exact values must reach the spec verbatim, else the spec waits.

const REQUEST = [
  "Use these colours on the dashboard:",
  "",
  "| Token | Light | Dark |",
  "|---|---|---|",
  "| `--surface` | #FFFFFF | #10141A |",
  "| `--accent` | #3B82F6 | #60A5FA |",
  "",
  "Run `npm run build:tokens` after. See issue #570.",
].join("\n");
const VALUES = ["#FFFFFF", "#10141A", "#3B82F6", "#60A5FA", "npm run build:tokens", "--surface", "--accent", "Token", "Light", "Dark"];
/** The table as triage is told to copy it: verbatim, under Given values. */
const KEPT = ["Change the dashboard colours.", "", "Given values:", "", ...REQUEST.split("\n").slice(2)].join("\n");
const DROPPED = KEPT.replace("#60A5FA", "a lighter blue");

describe("givenValues", () => {
  it("finds the hex colours, code spans and table cells, each once", () => {
    const found = givenValues(REQUEST);
    for (const v of VALUES) expect(found, v).toContain(v);
    expect(new Set(found).size).toBe(found.length);
  });

  it("takes no issue number for a colour, and no value from a fenced block but its hex colours", () => {
    const found = givenValues("Fixes #570 and #1234.\n\n```\n| a | b |\n|---|---|\n`x` #abc\n```\n");
    expect(found).toEqual(["#abc"]);
  });
});

describe("missingValues", () => {
  it("is empty for a spec that keeps every value of the request's table", () => {
    expect(missingValues(REQUEST, KEPT)).toEqual([]);
  });

  it("reports the value a spec drops", () => {
    expect(missingValues(REQUEST, DROPPED)).toEqual(["#60A5FA"]);
  });

  it("matches a hex colour in any letter case, other values exactly", () => {
    expect(missingValues(REQUEST, KEPT.toLowerCase())).not.toContain("#3B82F6");
    expect(missingValues(REQUEST, KEPT.toLowerCase())).toContain("Token");
  });

  it("is empty for a request with no given values", () => {
    expect(missingValues("Make the page faster.", "")).toEqual([]);
  });
});

const spec = (problem: string) => {
  const p = parseTriage({ ...triageSpec, problem }, { max_diff_lines: 1500, max_diff_files: 40 });
  if (!p.ok) throw new Error(p.error);
  return p.value;
};

describe("specText", () => {
  it("holds the problem and the other fields the implementer gets", () => {
    const text = specText(spec(KEPT));
    expect(text).toContain("#60A5FA");
    expect(text).toContain(triageSpec.done_criteria[0]);
    expect(text).toContain(triageSpec.allowed_paths[0]);
  });
});

describe("the spec comment", () => {
  it("lists the missing values in their own section before the footer", () => {
    const body = renderSpec(spec(DROPPED), 2, {}, "THE FOOTER", { missing: ["#60A5FA"] });
    const section = body.indexOf("### Values from the request missing in the spec");
    expect(section).toBeGreaterThan(body.indexOf("### Risk"));
    expect(body.indexOf("- `#60A5FA`")).toBeGreaterThan(section);
    expect(body.indexOf("THE FOOTER")).toBeGreaterThan(body.indexOf("- `#60A5FA`"));
  });

  it("has no such section when nothing is missing", () => {
    expect(renderSpec(spec(KEPT), 2, {}, "F", { missing: [] })).not.toContain("missing in the spec");
  });
});

/** The pipeline with auto approval by tier (spec_gate_min_tier 3, the spec at tier 2), the request as the item's body. */
async function triaged(problem: string) {
  const f = await pipeline();
  f.runner.script.triage = () => ({ output: { ...triageSpec, problem } });
  f.source.queue.push({ kind: "item_requested", source: issueRef(1), requester: alice, title: "Colours", body: REQUEST });
  await f.controller.tickIntake();
  const created = (await f.store.getWorkItemBySource("github_issue", issueRef(1).id))!;
  await f.step();
  return { f, item: await f.item(created) };
}

describe("triage with a fake model", () => {
  it("is given the request's table and stores a spec whose text keeps every value", async () => {
    const { f, item } = await triaged(KEPT);
    const asked = f.runner.specs.find((s) => s.role === "triage")!.prompt;
    expect(asked).toContain("| `--accent` | #3B82F6 | #60A5FA |");
    expect(item.issue_text).toContain(REQUEST);
    const stored = [item.problem, ...(item.done_criteria ?? []), item.desired_output ?? "", item.scope ?? ""].join("\n");
    for (const v of VALUES) expect(stored, v).toContain(v);
    expect(missingValues(REQUEST, stored)).toEqual([]);
  });
});

describe("holding a spec that drops a value", () => {
  it("a spec that keeps every value is approved automatically as before", async () => {
    const { f, item } = await triaged(KEPT);
    expect(item.blocked_reason).not.toBe("spec_pending");
    expect(f.agentCalls("implement")).toBe(1);
  });

  it("a spec that drops one waits for /approve, names the value in the comment and the hold line, and /approve starts it", async () => {
    const { f, item } = await triaged(DROPPED);
    expect(item).toMatchObject({ stage: "READY", blocked_on: "human", blocked_reason: "spec_pending" });
    expect(f.agentCalls("implement")).toBe(0);
    const comment = f.source.comments.find((c) => c.marker.startsWith("<!-- factory:spec"))!.body;
    expect(comment).toContain("### Values from the request missing in the spec");
    expect(comment).toMatch(/waits for `\/approve`, with no automatic or standing approval: .*`#60A5FA`/);

    f.source.queue.push({ kind: "spec_approved", source: item.source, comment_id: "c1", approver: alice, note: "" });
    await f.controller.tickIntake();
    await f.step();
    expect(f.agentCalls("implement")).toBe(1);
  });

  it("a standing rule does not approve it", async () => {
    // The spec gate at every tier (the test config's spec_gate_min_tier 1), so a tier 1 spec reaches the standing rule.
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const source = new FakeSource();
    const settings = new LiveSettings({ config, base: baseFromConfig(config), source: store });
    const controller = new ControllerRole({
      store, source, forge: new FakeForge(source), auth: new FakeAuth(), clock, config, settings, log: silent, scanner: cleanScanner, repeated_failure_rule: false,
    });
    let n = 0;
    const send = async (e: SourceEvent) => {
      clock.advance(1000);
      source.queue.push(e);
      await controller.tickIntake();
    };
    const triage = async (problem: string): Promise<WorkItem> => {
      const src = issueRef(++n);
      await send({ kind: "item_requested", source: src, requester: alice, title: `t${n}`, body: REQUEST });
      const out = { ...triageSpec, problem, tier: 1, allowed_paths: ["docs/guide.md"], files_to_change: ["docs/guide.md"] };
      for (let run = await store.claimRun({ worker_id: "w1" as WorkerId, kinds: ["triage"], lease_ms: 60_000 }); run;
        run = await store.claimRun({ worker_id: "w1" as WorkerId, kinds: ["triage"], lease_ms: 60_000 })) {
        await store.completeRun(run.id, run.lease!.token, { status: "succeeded", summary: "s", data: { spec: out, tokens: 10 } });
      }
      clock.advance(1000);
      await controller.tickRuns();
      return (await store.getWorkItemBySource("github_issue", src.id))!;
    };
    const host = await triage(KEPT);
    await send({ kind: "standing_requested", source: host.source, comment_id: "s1", requester: alice, args: "accept spec-t1" });
    expect((await store.listStandingRules()).find((r) => r.gate === "spec" && r.tier === 1)?.enabled).toBe(true);

    expect((await triage(KEPT)).stage).toBe("RUNNING");
    const dropped = await triage(DROPPED);
    expect(dropped).toMatchObject({ stage: "READY", blocked_reason: "spec_pending" });
  });
});
