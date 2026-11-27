import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentsHomeTacitLedger, TACIT_AGENT, TACIT_CLI_TIMEOUT_MS } from "../src/impl/tacit/agents-home-tacit-ledger.js";
import { alice, config, issueRef } from "./helpers/fakes/config.js";
import { stubHome, snapshot, SPEC_PENDING, MERGE_PENDING, harness, revise, reject, verdict, driverOf } from "./helpers/tacit-ledger-stub.js";

describe("plugin agents-home", () => {
  it("a /revise, a /reject and a changes verdict each capture one record keyed by the comment ID; a redelivery adds none", async () => {
    const s = stubHome();
    const before = snapshot(s.home);
    const h = await harness(new AgentsHomeTacitLedger(s.home));
    const a = await h.itemIn(issueRef(1), SPEC_PENDING, "spec of one");
    const b = await h.itemIn(issueRef(2), SPEC_PENDING, "spec of two");
    const c = await h.itemIn(issueRef(3), MERGE_PENDING, "review of three", "review");

    for (let round = 0; round < 2; round++) {
      await h.send(revise(1, "keep the existing CLI flag\nand its help text"));
      await h.send(reject(2, "out of scope: belongs in the UI"));
      await h.send(verdict(3, "changes minor rename it\nand split the test"));
    }

    expect(await h.get(b)).toMatchObject({ stage: "CLOSED", close_reason: "rejected" });
    const empty = { root_reason: "", hypothesis: "", improvement: "", rule_draft: "" };
    expect(s.captures()).toEqual([
      { session: a.id, proposal: "spec of one", pushback: "keep the existing CLI flag\nand its help text", ...empty },
      { session: b.id, proposal: "spec of two", pushback: "out of scope: belongs in the UI", ...empty },
      { session: c.id, proposal: "review of three", pushback: "rename it\nand split the test", ...empty },
    ]);
    expect((await h.captureRows()).map((r) => r.intent_key)).toEqual([`tacit:${a.id}:c1`, `tacit:${b.id}:c2`, `tacit:${c.id}:c3`]);
    // The record goes on stdin; argv carries only the subcommand and the agent.
    expect(s.argv()).toEqual(Array(3).fill(`tacit|capture|--agent|${TACIT_AGENT}`));
    // A capture writes nothing under the home: only the stubs ran, and they wrote outside it.
    expect(snapshot(s.home)).toEqual(before);
  });

  it("an accept verdict and a refused command capture nothing", async () => {
    const s = stubHome();
    const h = await harness(new AgentsHomeTacitLedger(s.home));
    await h.itemIn(issueRef(3), MERGE_PENDING, "review", "review");
    await h.send(verdict(3, "accept none"));
    // A /revise on a merge-pending item's issue is refused (it goes on the PR).
    await h.send(revise(3, "more"));
    expect(await h.captureRows()).toEqual([]);
    expect(s.captures()).toEqual([]);
  });

  it("a failing CLI leaves the command's result unchanged, holds only the ledger's destination, and is retried with backoff", async () => {
    const s = stubHome();
    s.control("fail", true);
    const h = await harness(new AgentsHomeTacitLedger(s.home));
    const a = await h.itemIn(issueRef(1), SPEC_PENDING, "spec of one");
    await h.send(reject(1, "no"));
    expect(await h.get(a)).toMatchObject({ stage: "CLOSED", close_reason: "rejected" });
    const [batch] = await driverOf(h.store).all("SELECT * FROM outbound_batches WHERE destination = 'tacit:ledger'");
    expect(batch).toMatchObject({ state: "failed", attempts: 1 });
    expect(String(batch!.last_error)).toContain("ledger locked");

    // GitHub keeps sending: the reject's close and comment, and a later refusal on another item.
    expect(h.source.closed).toEqual([a.source]);
    await h.itemIn(issueRef(2), SPEC_PENDING, "spec of two");
    await h.send({ kind: "retry_requested", source: issueRef(2), comment_id: "r2", requester: alice, note: "" });
    expect(h.source.comments.some((c) => c.marker === "<!-- factory:refused:r2 -->")).toBe(true);
    expect(s.captures()).toEqual([]);

    // Not before its backoff; then once.
    s.control("fail", false);
    await h.controller.tickOutbox();
    expect(s.captures()).toEqual([]);
    h.clock.advance(config.retry_max_ms);
    await h.controller.tickOutbox();
    await h.controller.tickOutbox();
    expect(s.captures().map((r) => r.pushback)).toEqual(["no"]);
  });

  it("a CLI call that runs past its timeout is stopped and fails", async () => {
    expect(TACIT_CLI_TIMEOUT_MS).toBe(30_000);
    const s = stubHome();
    s.control("sleep", true);
    const ledger = new AgentsHomeTacitLedger(s.home, 200);
    const started = Date.now();
    await expect(ledger.capture({ session: "w", proposal: "p", pushback: "x" })).rejects.toThrow(/stopped after 200 ms/);
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(s.captures()).toEqual([]);
  });

  it("pushback text passes the egress scanner first: a flagged text is replaced by the notice naming the rules", async () => {
    const s = stubHome();
    const h = await harness(new AgentsHomeTacitLedger(s.home));
    const c = await h.itemIn(issueRef(3), MERGE_PENDING, "review of three", "review");
    await h.send(verdict(3, "changes major the token SECRET-123 leaked"));
    expect(s.captures()).toEqual([expect.objectContaining({ session: c.id, proposal: "review of three" })]);
    const pushback = String(s.captures()[0]!.pushback);
    expect(pushback).not.toContain("SECRET");
    expect(pushback).toContain("test_rule");
  });

  it("the stubs refuse any form the real CLIs do not take, with usage text", () => {
    const s = stubHome();
    const run = (cli: string, args: string[]) => {
      try {
        execFileSync(join(s.home, "bin", cli), args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        return "ok";
      } catch (err) {
        const e = err as { status: number; stderr: string };
        return `${e.status}: ${e.stderr.trim()}`;
      }
    };
    for (const args of [["list", "--agent", TACIT_AGENT, "--state", "pending", "--json"], ["verdict", "--agent", TACIT_AGENT], ["verdict", "P-1", "hold", "--reason", "r"], ["capture"]]) {
      expect(run("tacit", args)).toMatch(/^2: usage: tacit/);
    }
    for (const args of [["verdict", "--agent", TACIT_AGENT], ["verdict", "P-1", "retire", "--reason", "r"], ["verdict", "P-1", "promote", "--reason", "r", "--rule", "x"], ["pending", "--json"]]) {
      expect(run("evolve", args)).toMatch(/^2: usage: evolve/);
    }
    expect(run("tacit", ["verdict", "C-1", "retire", "--reason", "r"])).toBe("ok");
  });
});
