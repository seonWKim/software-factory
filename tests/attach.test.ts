import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import command from "../src/cli/handlers/attach/attach.command.js";
import { ATTACH_USAGE, type AttachCliDeps, MAX_IMAGE_BYTES, parseAttachArgs, runAttach } from "../src/core/attachments.js";
import type { UserId } from "../src/core/types.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { issue, newStore, system } from "./helpers/store.js";

// `factory attach` (design 02-attachments): one folder per command, the image and link forms, every refusal one line
// with nothing stored, and the owner check first.

const ME = "local:me@example.com" as UserId;
const SECRET = "known-secret-value-0123456789";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1]);

async function setup(files: Record<string, { size: number; bytes: Uint8Array }> = {}, allow = true) {
  const { store } = await newStore();
  const { item } = await store.createWorkItem(issue(1), system);
  const d: AttachCliDeps = {
    store, user: ME, env: {}, newId: (() => { let n = 0; return () => `id${++n}`; })(),
    scanner: new PatternEgressScanner(async () => [SECRET]),
    auth: { authorize: async () => (allow ? { allow: true } : { allow: false, reason: "only the owner may do that" }) },
    read: async (p) => { const f = files[p]; if (!f) throw new Error("ENOENT"); return f; },
  };
  return { store, item, d };
}

const file = (bytes: Uint8Array) => ({ size: bytes.length, bytes });

describe("factory attach", () => {
  it("lives in src/cli/handlers/attach/attach.command.ts, defined with defineCommand", () => {
    const dir = join(import.meta.dirname, "..", "src", "cli", "handlers", "attach");
    expect(readdirSync(dir)).toContain("attach.command.ts");
    expect(existsSync(join(dir, "attach.command.ts"))).toBe(true);
    expect(command).toMatchObject({ kind: "command", names: ["attach"] });
  });

  it("parses the file form and the link form with an optional label", () => {
    expect(parseAttachArgs(["wi_1", "a.png"])).toEqual({ id: "wi_1", file: "a.png" });
    expect(parseAttachArgs(["wi_1", "--link", "https://x.dev/v"])).toEqual({ id: "wi_1", url: "https://x.dev/v", label: null });
    expect(parseAttachArgs(["wi_1", "--link", "https://x.dev/v", "the", "video"])).toEqual({ id: "wi_1", url: "https://x.dev/v", label: "the video" });
    for (const bad of [[], ["wi_1"], ["wi_1", "--link"], ["wi_1", "a.png", "b.png"]]) expect(parseAttachArgs(bad)).toEqual({ error: ATTACH_USAGE });
  });

  it("stores a png, jpeg, gif or webp up to 5 MB on a New item", async () => {
    const big = new Uint8Array(MAX_IMAGE_BYTES);
    big.set(PNG);
    const { store, item, d } = await setup({ "a.png": file(PNG), "b.jpg": file(JPEG), "c.gif": file(GIF), "dir/d.webp": file(WEBP), "e.png": file(big) });
    for (const p of ["a.png", "b.jpg", "c.gif", "dir/d.webp", "e.png"]) {
      const r = await runAttach(d, { id: item.id, file: p });
      expect(r.code, p).toBe(0);
      expect(r.lines[0]).toMatch(/^attached at_id\d+: image /);
    }
    const rows = await store.listAttachments(item.id);
    expect(rows.map((a) => [a.media_type, a.name, a.size_bytes])).toEqual([
      ["image/png", "a.png", PNG.length], ["image/jpeg", "b.jpg", JPEG.length], ["image/gif", "c.gif", GIF.length], ["image/webp", "d.webp", WEBP.length], ["image/png", "e.png", MAX_IMAGE_BYTES],
    ]);
    expect(Buffer.from(rows[0]!.data!, "base64")).toEqual(Buffer.from(PNG));
    expect(rows.every((a) => a.created_by === ME && a.work_item_id === item.id)).toBe(true);
  });

  it("refuses another type, a larger file or another stage with one line, and stores nothing", async () => {
    const head = PNG.slice(0, 12);
    const { store, item, d } = await setup({ "a.txt": file(new TextEncoder().encode("hello")), "big.png": { size: MAX_IMAGE_BYTES + 1, bytes: head }, "a.png": file(PNG) });
    const txt = await runAttach(d, { id: item.id, file: "a.txt" });
    expect(txt).toEqual({ code: 1, lines: [expect.stringContaining("only a png, jpeg, gif or webp image can be attached")] });
    const big = await runAttach(d, { id: item.id, file: "big.png" });
    expect(big).toEqual({ code: 1, lines: [expect.stringContaining("the largest taken is 5 MB")] });
    expect(await runAttach(d, { id: item.id, file: "missing.png" })).toEqual({ code: 1, lines: ["nothing was attached: cannot read missing.png"] });
    await store.transition({ id: item.id, expected_version: item.version, actor: system, reason: "triaged", patch: { stage: "READY", blocked_on: "human", blocked_reason: "spec_pending" } });
    for (const a of [{ id: item.id, file: "a.png" }, { id: item.id, file: "big.png" }, { id: item.id, url: "https://x.dev", label: null }]) {
      expect(await runAttach(d, a)).toEqual({ code: 1, lines: ["nothing was attached: attachments are taken only while the item is New or in triage, and it is spec waiting for approval"] });
    }
    expect(await store.listAttachments(item.id)).toEqual([]);
  });

  it("stores an http or https link with an optional label; another scheme or a scan finding stores nothing", async () => {
    const { store, item, d } = await setup();
    expect((await runAttach(d, { id: item.id, url: "https://x.dev/video", label: "the video" })).code).toBe(0);
    expect((await runAttach(d, { id: item.id, url: "http://x.dev/shot", label: null })).code).toBe(0);
    expect(await runAttach(d, { id: item.id, url: "ftp://x.dev/a", label: null })).toEqual({ code: 1, lines: ["nothing was attached: only an http or https URL can be attached"] });
    expect(await runAttach(d, { id: item.id, url: "javascript:alert(1)", label: null })).toEqual({ code: 1, lines: ["nothing was attached: only an http or https URL can be attached"] });
    const leak = await runAttach(d, { id: item.id, url: `https://x.dev/?t=${SECRET}`, label: null });
    expect(leak.code).toBe(1);
    expect(leak.lines).toEqual([expect.stringContaining("the link was blocked by the leak scanner")]);
    expect(leak.lines[0]).not.toContain(SECRET);
    expect((await store.listAttachments(item.id)).map((a) => [a.kind, a.url, a.label])).toEqual([["link", "https://x.dev/video", "the video"], ["link", "http://x.dev/shot", null]]);
  });

  it("refuses a sender the owner check refuses, before anything is read or stored", async () => {
    const { store, item, d } = await setup({ "a.png": file(PNG) }, false);
    expect(await runAttach(d, { id: item.id, file: "a.png" })).toEqual({ code: 1, lines: ["nothing was attached: only the owner may do that"] });
    expect(await store.listAttachments(item.id)).toEqual([]);
  });
});
