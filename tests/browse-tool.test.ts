import { describe, expect, it } from "vitest";
import { Browse, OUTPUT_CAP, TOOLS, type ToolContext, type ToolResult, guardPolicy } from "../src/core/tools/index.js";
import type { Sandbox, SandboxHandle } from "../src/interfaces/sandbox.js";

// The routine role's Browse tool: GET of the one owner-set URL (`browse_url` in the guard policy), no sandbox.

const OWNER_URL = "https://status.example.com/page";

/** A sandbox whose every method throws: Browse must never reach it. */
const noSandbox = new Proxy({}, { get: () => () => { throw new Error("Browse touched the sandbox"); } }) as unknown as Sandbox;
const handle = { id: "sbx_none", workdir: "/w/run" } as unknown as SandboxHandle;

interface Call { url: string; init: RequestInit }

function ctx(browse_url: string | null | undefined, respond: (c: Call) => Response = () => new Response("hello")) {
  const calls: Call[] = [];
  const c: ToolContext = {
    sandbox: noSandbox,
    handle,
    policy: guardPolicy({ workdir: "/w/run", deny_paths: [], writable_paths: [], env_allowlist: {}, ...(browse_url !== undefined && { browse_url }) }),
    fetch: async (url, init) => {
      const call = { url: String(url), init: init ?? {} };
      calls.push(call);
      return respond(call);
    },
  };
  return { c, calls };
}

function refused(r: ToolResult): string {
  if (r.ok) throw new Error(`expected a refusal, got ${r.content}`);
  return r.error;
}

describe("Browse", () => {
  it("is a read tool named in TOOLS", () => {
    expect(Browse.capability).toBe("read");
    expect(TOOLS).toContain(Browse);
    expect(Browse.input_schema).toMatchObject({ type: "object", additionalProperties: false });
  });

  it("GETs the owner-set URL, with no body and no redirect followed, and returns its text", async () => {
    const { c, calls } = ctx(OWNER_URL);
    const r = await Browse.run({}, c);
    expect(r).toEqual({ ok: true, content: "hello" });
    expect(calls.map((x) => x.url)).toEqual([OWNER_URL]);
    expect(calls[0]!.init.method).toBe("GET");
    expect(calls[0]!.init.body).toBeUndefined();
    expect(calls[0]!.init.redirect).toBe("manual");
  });

  it("accepts the owner-set URL named in its input", async () => {
    const { c, calls } = ctx(OWNER_URL);
    expect((await Browse.run({ url: OWNER_URL }, c)).ok).toBe(true);
    expect(calls.map((x) => x.url)).toEqual([OWNER_URL]);
  });

  it("refuses any other URL and fetches nothing", async () => {
    const { c, calls } = ctx(OWNER_URL);
    for (const url of ["https://evil.example.com/", `${OWNER_URL}?q=secret`, "https://status.example.com/other"]) {
      expect(refused(await Browse.run({ url }, c))).toMatch(/only the owner-set URL/);
    }
    expect(calls).toEqual([]);
  });

  it("refuses when the owner set no URL", async () => {
    for (const set of [undefined, null]) {
      const { c, calls } = ctx(set);
      expect(refused(await Browse.run({}, c))).toMatch(/no URL/);
      expect(calls).toEqual([]);
    }
  });

  it("refuses an owner-set URL that is not http or https, or carries credentials", async () => {
    for (const url of ["file:///etc/passwd", "ftp://x.example.com/", "https://u:p@x.example.com/", "not a url"]) {
      const { c, calls } = ctx(url);
      refused(await Browse.run({}, c));
      expect(calls).toEqual([]);
    }
  });

  it("does not follow a redirect, and reports a failed status", async () => {
    const moved = ctx(OWNER_URL, () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example.com/" } }));
    expect(refused(await Browse.run({}, moved.c))).toMatch(/redirect/);
    expect(moved.calls).toHaveLength(1);
    const missing = ctx(OWNER_URL, () => new Response("nope", { status: 404 }));
    expect(refused(await Browse.run({}, missing.c))).toMatch(/404/);
  });

  it("cuts long pages at the output cap, and a fetch error is a result, not a throw", async () => {
    const long = ctx(OWNER_URL, () => new Response("x".repeat(OUTPUT_CAP + 10)));
    const r = await Browse.run({}, long.c);
    expect(r).toMatchObject({ ok: true, truncated: true });
    if (r.ok) expect(r.content).toHaveLength(OUTPUT_CAP);
    const down = ctx(OWNER_URL, () => { throw new Error("ECONNREFUSED"); });
    expect(refused(await Browse.run({}, down.c))).toMatch(/ECONNREFUSED/);
  });
});
