import { describe, expect, it } from "vitest";
import type { RunId, WorkItemId } from "../src/core/types.js";
import { FallbackRunner } from "../src/core/fallback-runner.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { ClaudeCodeRunner } from "../src/impl/runner/claude-code-runner.js";
import type { AgentRunResult, AgentRunSpec, AgentRunner } from "../src/interfaces/agent-runner.js";
import type { EgressChannel, EgressScanner } from "../src/interfaces/egress-scanner.js";
import type { ExecResult, Sandbox } from "../src/interfaces/sandbox.js";
import { LIVE_WRITE_MS, LiveTranscript } from "../src/worker/live-transcript.js";
import { MemoryStorage, pipeline, recordingLog } from "./helpers/fakes.js";

// The live transcript (design 09-dashboard-item): while an agent step runs, the worker stores its output so far,
// at most once per 5 s and only when it grew, each write egress-scanned on `log` first. A pattern hit alone skips
// that write; a known secret or the canary stops the agent and fails the run with egress_blocked. The Claude Code
// runner feeds it from its stdout stream; the fallback chain passes it to the member that is running.

/** Token-shaped and canary-shaped, built here so this file holds no literal the scanner flags. */
const TOKEN = `ghp_${"Ab3".repeat(12)}`;
const CANARY = `sf-canary-${"a1b2c3d4"}`;
const KEY = "transcripts/wi_1/run_1.json";
const dec = new TextDecoder();
const line = (text: string) => `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } })}\n`;
/** Lets the writer's scan and put (each a few awaits) finish. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

class RecordingScanner implements EgressScanner {
  channels: EgressChannel[] = [];
  private readonly inner = new PatternEgressScanner(async () => []);
  scan(channel: EgressChannel, content: string) {
    this.channels.push(channel);
    return this.inner.scan(channel, content);
  }
}

function writer(step?: string) {
  const clock = new FakeClock();
  const storage = new MemoryStorage();
  const puts: string[] = [];
  const put = storage.put.bind(storage);
  storage.put = async (k, v) => {
    puts.push(`${k} ${dec.decode(v)}`);
    await put(k, v);
  };
  const log = recordingLog();
  const scanner = new RecordingScanner();
  const live = new LiveTranscript({ clock, storage, log, scanner }, { item: "wi_1", run: "run_1", step });
  const stored = (k = KEY) => (storage.data.has(k) ? dec.decode(storage.data.get(k)!) : null);
  return { clock, storage, puts, log, scanner, live, stored };
}

describe("live transcript: the worker's partial writes", () => {
  it("writes the first output at once, then at most once per 5 s, and only when it grew", async () => {
    const w = writer();
    w.live.push(line("one"));
    await settle();
    expect(w.stored()).toBe(line("one"));
    w.live.push(line("one") + line("two"));
    await settle();
    expect(w.puts).toHaveLength(1);
    w.clock.advance(LIVE_WRITE_MS - 1);
    await settle();
    expect(w.puts).toHaveLength(1);
    w.clock.advance(1);
    await settle();
    expect(w.stored()).toBe(line("one") + line("two"));
    // No growth: no write, however long it waits.
    w.clock.advance(LIVE_WRITE_MS * 3);
    await settle();
    expect(w.puts).toHaveLength(2);
    expect(w.scanner.channels.every((c) => c === "log")).toBe(true);
    await w.live.close();
  });

  it("writes whole lines only, so no page shows a cut event", async () => {
    const w = writer();
    w.live.push(line("one").slice(0, 10));
    await settle();
    expect(w.puts).toEqual([]);
    w.live.push(line("one") + line("two").slice(0, 5));
    await settle();
    expect(w.stored()).toBe(line("one"));
    await w.live.close();
  });

  it("a second step writes its own part", async () => {
    const w = writer("resolve");
    w.live.push(line("one"));
    await settle();
    expect(w.stored("transcripts/wi_1/run_1.resolve.json")).toBe(line("one"));
    await w.live.close();
  });

  it("a pattern-only hit skips that write and the step goes on; the final transcript replaces the last partial", async () => {
    const w = writer();
    w.live.push(line("one"));
    await settle();
    w.clock.advance(LIVE_WRITE_MS);
    w.live.push(line("one") + line(`expected '${TOKEN}' to be null`));
    await settle();
    expect(w.stored()).toBe(line("one"));
    expect(w.live.stop.signal.aborted).toBe(false);
    expect(w.log.lines.find((l) => l.msg === "partial transcript not stored: the egress scan flagged it")?.fields).toMatchObject({ run_id: "run_1", rules: "github_token" });
    expect(JSON.stringify(w.log.lines)).not.toContain(TOKEN);
    await w.live.finish(line("one") + line("done"));
    expect(w.stored()).toBe(line("one") + line("done"));
  });

  it("a known secret or the canary stops the agent, and the step's end fails the run with egress_blocked", async () => {
    const w = writer();
    w.live.push(line(`leaked ${CANARY}`));
    await settle();
    expect(w.live.stop.signal.aborted).toBe(true);
    expect(w.puts).toEqual([]);
    await expect(w.live.finish("")).rejects.toMatchObject({ code: "egress_blocked", message: "factory_canary" });
    expect(w.puts).toEqual([]);
  });

  it("after close no partial write happens; finish waits for the one in flight before the final write", async () => {
    const w = writer();
    w.live.push(line("one"));
    w.live.push(line("one"));
    const done = w.live.finish(line("final"));
    w.live.push(line("one") + line("late"));
    w.clock.advance(LIVE_WRITE_MS);
    await done;
    await settle();
    expect(w.puts.at(-1)).toBe(`${KEY} ${line("final")}`);
    expect(w.puts.every((p) => !p.includes("late"))).toBe(true);
  });

  it("the worker stops the agent and fails the run with egress_blocked when a partial write holds the canary", async () => {
    const f = await pipeline({
      implement: async (spec) => {
        spec.live?.(line(`leaked ${CANARY}`));
        await settle();
        return spec.signal.aborted ? { status: "aborted", transcript: "" } : { output: { summary: "s", next_steps: "n" } };
      },
    });
    const item = await f.submit();
    await f.step();
    const [impl] = await f.runs(item, "implement");
    expect(impl!.status).toBe("failed");
    expect(impl!.outcome).toMatchObject({ status: "failed", error_code: "egress_blocked" });
    expect(f.runner.aborted.some((s) => s.role === "implement")).toBe(true);
  });

  it("the worker passes every agent step a live callback", async () => {
    const f = await pipeline();
    const item = await f.submit();
    await f.step();
    expect((await f.runs(item, "implement"))[0]!.status).toBe("succeeded");
    expect(f.runner.specs.filter((s) => s.role === "implement").every((s) => typeof s.live === "function")).toBe(true);
  });
});

describe("live transcript: the runners", () => {
  const spec = (live?: (o: string) => void): AgentRunSpec => ({
    run_id: "run_1" as RunId,
    work_item_id: "wi_1" as WorkItemId,
    role: "implement",
    sandbox: { id: "s", workdir: "/w" },
    system_prompt: "s",
    prompt: "p",
    tools: [],
    tool_grants: [],
    lease_token: 1,
    env_allowlist: {},
    deny_paths: [],
    writable_paths: [],
    model_class: "cheap",
    timeout_ms: 30_000,
    signal: new AbortController().signal,
    ...(live ? { live } : {}),
  });

  function claudeRunner(chunks: string[]) {
    const sandbox: Sandbox = {
      create: async () => ({ id: "s", workdir: "/w" }),
      updateBase: async () => "base",
      exec: async (_h, _cmd, opts): Promise<ExecResult> => {
        for (const c of chunks) opts.onStdout?.(c);
        return { exit_code: 0, signal: null, stdout: chunks.join(""), stderr: "", timed_out: false };
      },
      copyIn: async () => {},
      copyOut: async () => {},
      destroy: async () => {},
    };
    const homes = `${process.env.TMPDIR ?? "/tmp"}/sf-live-transcript-test`;
    return new ClaudeCodeRunner({
      sandbox,
      secrets: { get: async () => ({ reveal: () => "x" }) as never, valuesForScan: async () => [] },
      claudeConfigDir: `${homes}/cfg`,
      homesDir: homes,
      models: { cheap: "haiku", standard: "sonnet", strong: "opus" },
    });
  }

  const result = `${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok", usage: { input_tokens: 1, output_tokens: 1 } })}\n`;

  it("the Claude Code runner calls the live callback with its stdout so far, chunk by chunk", async () => {
    const chunks = [line("one"), line("two").slice(0, 7), line("two").slice(7), result];
    const seen: string[] = [];
    const r = await claudeRunner(chunks).run(spec((o) => seen.push(o)));
    expect(r.status).toBe("completed");
    expect(seen).toEqual(chunks.map((_, i) => chunks.slice(0, i + 1).join("")));
  });

  it("the Claude Code runner runs as before without one", async () => {
    const r = await claudeRunner([line("one"), result]).run(spec());
    expect(r.status).toBe("completed");
  });

  it("the fallback runner passes the live callback to the member that is running", async () => {
    const got: (AgentRunSpec["live"] | undefined)[] = [];
    const member = (status: AgentRunResult["status"]): AgentRunner => ({
      run: async (s) => {
        got.push(s.live);
        s.live?.(line(status));
        return { status, output: null, transcript: "", usage: { input_tokens: 0, output_tokens: 0, cost_usd: null } };
      },
    });
    const seen: string[] = [];
    const live = (o: string) => seen.push(o);
    await new FallbackRunner([{ name: "a", impl: member("rate_limited") }, { name: "b", impl: member("completed") }]).run(spec(live));
    expect(got).toEqual([live, live]);
    expect(seen).toEqual([line("rate_limited"), line("completed")]);
  });
});
