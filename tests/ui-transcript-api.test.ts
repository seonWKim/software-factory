// The transcript route (design §9, issue #303): GET /api/v1/items/<id>/runs/<run>/transcript reads a stored run
// transcript back one byte range at a time, scans every step on channel `ui`, withholds a flagged step whole,
// pages forward and from the end, filters on the server, and answers fixed 404 texts. Through respond(), no socket.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkItemId, WorkerId } from "../src/core/types.js";
import type { EgressChannel, EgressScanner } from "../src/interfaces/egress-scanner.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import type { SharedStorage, StorageRange } from "../src/interfaces/shared-storage.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { FsSharedStorage } from "../src/impl/storage/fs-shared-storage.js";
import { HealthMonitor } from "../src/ui/health.js";
import { type UiDeps, type UiResponse, respond } from "../src/ui/server.js";
import { PAGE_BYTES, TAIL_STEPS } from "../src/ui/transcript.js";
import { issue, newStore, system } from "./helpers/store.js";

const LEASE = 60_000;
// Built here so no secret-shaped literal sits in the repository.
const SECRET = `ghp_${"Ab3".repeat(12)}`;
const FIXTURES = join(import.meta.dirname, "fixtures", "transcripts");
const fixture = async (name: string) => (await readFile(join(FIXTURES, name), "utf8")).replaceAll("@@PLANTED_SECRET@@", SECRET);
const enc = (s: string) => new TextEncoder().encode(s);

/** In-memory storage that counts its reads: whole-file `get`s and every range asked for. */
class CountingStorage implements SharedStorage {
  data = new Map<string, Uint8Array>();
  gets = 0;
  ranges: { key: string; start: number; end: number; read: number }[] = [];
  failList = false;
  async put(k: string, v: Uint8Array) {
    this.data.set(k, v);
  }
  async get(k: string) {
    this.gets++;
    return this.data.get(k) ?? null;
  }
  async list(prefix: string) {
    if (this.failList) throw new Error("EIO: storage broke at /secret/path/xyz");
    return [...this.data.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
  async delete(k: string) {
    this.data.delete(k);
  }
  async getRange(k: string, start: number, end: number): Promise<StorageRange | null> {
    const v = this.data.get(k);
    if (!v) return null;
    const s = Math.min(start, v.length);
    const bytes = v.subarray(s, Math.max(s, Math.min(end, v.length)));
    this.ranges.push({ key: k, start, end, read: bytes.length });
    return { bytes, size: v.length };
  }
}

/** A scanner that records every channel it is asked about, over the pattern scanner. */
class RecordingScanner implements EgressScanner {
  calls: { channel: EgressChannel; content: string }[] = [];
  private readonly inner = new PatternEgressScanner(async () => []);
  scan(channel: EgressChannel, content: string) {
    this.calls.push({ channel, content });
    return this.inner.scan(channel, content);
  }
}

async function failedRun(store: FactoryStore, n: number, worker: string, key: string) {
  const it = (await store.createWorkItem({ ...issue(n), title: `Item ${n}` }, system)).item;
  const r0 = await store.transition({ id: it.id, expected_version: it.version, patch: {}, actor: system, reason: "x", enqueue: { kind: "implement", idempotency_key: key } });
  if (!r0.ok) throw new Error(r0.reason);
  const run = (await store.claimRun({ worker_id: worker as WorkerId, kinds: ["implement"], lease_ms: LEASE }))!;
  await store.completeRun(run.id, run.lease!.token, { status: "failed", error_code: "checks_failed", detail: "npm test failed", infra: false });
  return { item: it, run };
}

async function setup() {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const storage = new CountingStorage();
  const scanner = new RecordingScanner();
  const a = await failedRun(store, 1, "host:1:0", "a");
  const b = await failedRun(store, 2, "host:1:1", "b");
  const none = await failedRun(store, 3, "host:1:2", "c");
  await storage.put(`transcripts/${a.item.id}/${a.run.id}.json`, enc(await fixture("failed-run.jsonl")));
  await storage.put(`transcripts/${b.item.id}/${b.run.id}.json`, enc(await fixture("planted-secret.jsonl")));
  const d: UiDeps = {
    store, scanner, clock, lease_ms: LEASE, storage,
    health: new HealthMonitor(async () => [], clock),
  };
  return { d, store, storage, scanner, a, b, none };
}

const path = (item: WorkItemId, run: string, q = "") => `/api/v1/items/${encodeURIComponent(item)}/runs/${encodeURIComponent(run)}/transcript${q}`;

function get(d: UiDeps, url: string, method = "GET"): Promise<UiResponse> {
  return respond(d, { method, url, host: "127.0.0.1:4310" });
}

interface Body {
  run: { id: string; status: string; worker_id: string | null; outcome: { status: string; error_code: string | null; detail: string | null } | null };
  format: string;
  size: number;
  start: number;
  next: number | null;
  earlier: boolean;
  parts: string[];
  steps: { id: string; kind: string; tool: string | null; text: string; is_error: boolean; withheld: boolean }[];
}

async function body(d: UiDeps, url: string): Promise<Body> {
  const r = await get(d, url);
  expect(r.status, r.body).toBe(200);
  return JSON.parse(r.body) as Body;
}

describe("transcript api", () => {
  it("a failed run's transcript: its outcome, and its steps in order", async () => {
    const { d, a } = await setup();
    const t = await body(d, path(a.item.id, a.run.id));
    expect(t.run).toMatchObject({ id: a.run.id, status: "failed", worker_id: "host:1:0", outcome: { status: "failed", error_code: "checks_failed", detail: "npm test failed" } });
    expect(t.format).toBe("stream-json");
    expect(t.next).toBeNull();
    expect(t.parts).toEqual([""]);
    const kinds = t.steps.map((s) => `${s.kind}${s.tool ? `:${s.tool}` : ""}`);
    expect(kinds).toEqual(["system", "text", "tool_use:Read", "tool_result", "tool_use:Edit", "tool_result", "tool_use:Bash", "tool_result", "text", "result"]);
    expect(t.steps[6]!.text).toBe("npm test");
    expect(t.steps[7]!.is_error).toBe(true);
    expect(t.steps.at(-1)).toMatchObject({ kind: "result", is_error: true });
  });

  it("a planted secret withholds its whole step, and its text is nowhere in the response", async () => {
    const { d, b } = await setup();
    const r = await get(d, path(b.item.id, b.run.id));
    expect(r.status).toBe(200);
    expect(r.body).not.toContain(SECRET);
    expect(r.body).not.toContain("x-access-token");
    const t = JSON.parse(r.body) as Body;
    const flagged = t.steps.find((s) => s.withheld)!;
    expect(flagged).toMatchObject({ kind: "tool_result", text: "[withheld: github_token]", tool: null });
    // The steps around it are shown as they are.
    expect(t.steps[0]!.text).toBe("Checking the remote.");
    expect(t.steps.filter((s) => s.withheld)).toHaveLength(1);
  });

  it("every text of the response passes the scanner on channel ui", async () => {
    const { d, a, scanner } = await setup();
    scanner.calls = [];
    const t = await body(d, path(a.item.id, a.run.id));
    expect(scanner.calls.length).toBeGreaterThan(0);
    expect(new Set(scanner.calls.map((c) => c.channel))).toEqual(new Set(["ui"]));
    for (const s of t.steps) expect(scanner.calls.some((c) => c.content.includes(s.text)), s.text).toBe(true);
    expect(scanner.calls.some((c) => c.content === "npm test failed")).toBe(true);
  });

  it("a transcript that is not stream-json shows as plain lines", async () => {
    const { d, a, storage } = await setup();
    await storage.put(`transcripts/${a.item.id}/${a.run.id}.json`, enc(await fixture("plain.txt")));
    const t = await body(d, path(a.item.id, a.run.id));
    expect(t.format).toBe("plain");
    expect(t.steps.map((s) => [s.kind, s.text])).toEqual([
      ["plain", "starting the agent"], ["plain", "not json: { broken"], ["plain", "step two finished"],
    ]);
  });

  it("unknown run, another item's run and no stored transcript are 404s with fixed texts", async () => {
    const { d, a, b, none, storage } = await setup();
    for (const url of [path(a.item.id, "run_nope"), path(a.item.id, b.run.id), path(none.item.id, none.run.id), path("wi_nope" as WorkItemId, a.run.id), path(a.item.id, a.run.id, "?part=fix")]) {
      const r = await get(d, url);
      expect(r.status, url).toBe(404);
      expect(Object.keys(JSON.parse(r.body))).toEqual(["error"]);
    }
    storage.failList = true;
    const r = await get(d, path(a.item.id, a.run.id));
    expect(r.status).toBe(500);
    expect(r.body).not.toContain("secret");
    expect(r.body).not.toContain("EIO");
  });

  it("is GET and HEAD only", async () => {
    const { d, a } = await setup();
    expect((await get(d, path(a.item.id, a.run.id), "HEAD")).status).toBe(200);
    for (const m of ["POST", "PUT", "DELETE"]) {
      const r = await get(d, path(a.item.id, a.run.id), m);
      expect(r.status, m).toBe(405);
      expect(r.headers.allow).toBe("GET, HEAD");
    }
  });

  it("bad offset or filter is a 400", async () => {
    const { d, a } = await setup();
    expect((await get(d, path(a.item.id, a.run.id, "?offset=-1"))).status).toBe(400);
    expect((await get(d, path(a.item.id, a.run.id, "?filter=everything"))).status).toBe(400);
  });

  it("the filter shows only matching tool calls", async () => {
    const { d, a } = await setup();
    const kinds = async (f: string) => (await body(d, path(a.item.id, a.run.id, `?filter=${f}`))).steps.map((s) => s.tool);
    expect(await kinds("edits")).toEqual(["Edit"]);
    expect(await kinds("commands")).toEqual(["Bash"]);
    expect(await kinds("reads")).toEqual(["Read"]);
  });

  it("the item route lists each run's worker and its stored transcript parts", async () => {
    const { d, a, none, storage } = await setup();
    await storage.put(`transcripts/${a.item.id}/${a.run.id}.resolve.json`, enc("x\n"));
    type Detail = { runs: { id: string; attempts: { worker_id: string | null }[] }[]; transcripts: Record<string, string[]> };
    const r = JSON.parse((await get(d, `/api/v1/items/${a.item.id}`)).body) as Detail;
    expect(r.runs.find((x) => x.id === a.run.id)!.attempts.at(-1)!.worker_id).toBe("host:1:0");
    expect(r.transcripts).toEqual({ [a.run.id]: ["", "resolve"] });
    const r2 = JSON.parse((await get(d, `/api/v1/items/${none.item.id}`)).body) as Detail;
    expect(r2.transcripts).toEqual({});
    expect(storage.gets).toBe(0);
    // A second part opens by name.
    const t = await body(d, path(a.item.id, a.run.id, "?part=resolve"));
    expect(t.steps.map((s) => s.text)).toEqual(["x"]);
  });
});

describe("transcript api: a 10 MB transcript", () => {
  /** ~10 MB of stream-json: every 7th line an Edit, every 3rd a Bash call, the rest tool results. */
  function big(): { text: string; lines: number } {
    const out: string[] = [];
    let size = 0;
    for (let i = 0; size < 10 * 1024 * 1024; i++) {
      const line =
        i % 7 === 0
          ? JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: `t${i}`, name: "Edit", input: { file_path: `src/f${i}.ts`, old_string: "a", new_string: "b" } }] } })
          : i % 3 === 0
            ? JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: `t${i}`, name: "Bash", input: { command: `echo step ${i}` } }] } })
            : JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `t${i}`, content: `result ${i} ${"z".repeat(120)}` }] } });
      out.push(line);
      size += line.length + 1;
    }
    return { text: `${out.join("\n")}\n`, lines: out.length };
  }

  it("the first page returns at most 64 KiB and reads only that range, never the whole file", async () => {
    const { d, a, storage } = await setup();
    const { text } = big();
    await storage.put(`transcripts/${a.item.id}/${a.run.id}.json`, enc(text));
    storage.ranges = [];
    const r = await get(d, path(a.item.id, a.run.id));
    expect(r.status).toBe(200);
    expect(Buffer.byteLength(r.body)).toBeLessThanOrEqual(PAGE_BYTES);
    expect(storage.gets).toBe(0);
    expect(storage.ranges).toHaveLength(1);
    expect(storage.ranges[0]).toMatchObject({ start: 0 });
    expect(storage.ranges[0]!.end - storage.ranges[0]!.start).toBeLessThanOrEqual(PAGE_BYTES);
    const t = JSON.parse(r.body) as Body;
    expect(t.size).toBe(text.length);
    expect(t.steps.length).toBeGreaterThan(0);
    expect(t.steps[0]!.text).toBe("src/f0.ts\n- a\n+ b");

    // The next page starts where the first one stopped, with no step lost or repeated.
    storage.ranges = [];
    const t2 = await body(d, path(a.item.id, a.run.id, `?offset=${t.next}`));
    expect(storage.ranges).toHaveLength(1);
    expect(storage.ranges[0]!.end - storage.ranges[0]!.start).toBeLessThanOrEqual(PAGE_BYTES);
    const lastId = Number(t.steps.at(-1)!.text.match(/(?:result |step |f)(\d+)/)![1]);
    const firstId = Number(t2.steps[0]!.text.match(/(?:result |step |f)(\d+)/)![1]);
    expect(firstId).toBe(lastId + 1);
    expect(storage.gets).toBe(0);
  });

  it("the last 20 steps read only the end of the file", async () => {
    const { d, a, storage } = await setup();
    const { text, lines } = big();
    await storage.put(`transcripts/${a.item.id}/${a.run.id}.json`, enc(text));
    storage.ranges = [];
    const t = await body(d, path(a.item.id, a.run.id, "?tail=1"));
    expect(t.steps).toHaveLength(TAIL_STEPS);
    expect(t.steps.at(-1)!.text).toContain(`${lines - 1}`);
    expect(t.earlier).toBe(true);
    expect(storage.gets).toBe(0);
    for (const rg of storage.ranges) {
      expect(rg.read).toBeLessThanOrEqual(PAGE_BYTES);
      if (rg.read > 0) expect(rg.start).toBeGreaterThanOrEqual(text.length - PAGE_BYTES);
    }
  });

  it("the filter works across pages", async () => {
    const { d, a, storage } = await setup();
    const { text } = big();
    await storage.put(`transcripts/${a.item.id}/${a.run.id}.json`, enc(text));
    const p1 = await body(d, path(a.item.id, a.run.id, "?filter=edits"));
    const p2 = await body(d, path(a.item.id, a.run.id, `?filter=edits&offset=${p1.next}`));
    for (const s of [...p1.steps, ...p2.steps]) expect(s.tool).toBe("Edit");
    const ids = [...p1.steps, ...p2.steps].map((s) => Number(/f(\d+)/.exec(s.text)![1]));
    expect(ids.length).toBeGreaterThan(p1.steps.length);
    ids.forEach((id, i) => expect(id).toBe(i * 7));
    const tail = await body(d, path(a.item.id, a.run.id, "?filter=commands&tail=1"));
    expect(tail.steps).toHaveLength(TAIL_STEPS);
    for (const s of tail.steps) expect(s.tool).toBe("Bash");
    expect(storage.gets).toBe(0);
  });
});

describe("FsSharedStorage.getRange", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("reads one byte range and the size; null for a missing key", async () => {
    dir = await mkdtemp(join(tmpdir(), "sf-range-"));
    const s = new FsSharedStorage(dir);
    await s.put("transcripts/a/b.json", enc("0123456789"));
    const r = (await s.getRange("transcripts/a/b.json", 2, 5))!;
    expect(new TextDecoder().decode(r.bytes)).toBe("234");
    expect(r.size).toBe(10);
    expect((await s.getRange("transcripts/a/b.json", 0, 0))!.bytes.length).toBe(0);
    expect(new TextDecoder().decode((await s.getRange("transcripts/a/b.json", 8, 100))!.bytes)).toBe("89");
    expect(await s.getRange("transcripts/a/missing.json", 0, 10)).toBeNull();
    await expect(s.getRange("../escape", 0, 1)).rejects.toThrow();
  });
});
