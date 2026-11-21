// The fs storage's list(prefix) walks only the folder the prefix names (the Plugins page's "last used" lists one
// item's transcripts per run; walking the whole root each time made GET /api/v1/plugins take a minute). The keys it
// returns stay every key that starts with the prefix, sorted.

import { mkdtemp, rm } from "node:fs/promises";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FsSharedStorage } from "../src/impl/storage/fs-shared-storage.js";

vi.mock("node:fs/promises", async (actual) => {
  const real = await actual<typeof import("node:fs/promises")>();
  return { ...real, readdir: vi.fn(real.readdir) };
});

const dirs: string[] = [];
afterEach(async () => {
  vi.mocked(fsp.readdir).mockClear();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function storage(keys: readonly string[]): Promise<{ s: FsSharedStorage; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "fs-list-"));
  dirs.push(root);
  const s = new FsSharedStorage(root);
  for (const k of keys) await s.put(k, new TextEncoder().encode(k));
  return { s, root };
}

const KEYS = ["transcripts/a/r1.json", "transcripts/a/r1.fix.json", "transcripts/a/sub/r2.json", "transcripts/ab/r3.json", "transcripts/b/r4.json", "other/x.json", "top.json"];

describe("FsSharedStorage.list", () => {
  it("returns every key under the prefix, sorted, and none outside it", async () => {
    const { s } = await storage(KEYS);
    expect(await s.list("transcripts/a/")).toEqual(["transcripts/a/r1.fix.json", "transcripts/a/r1.json", "transcripts/a/sub/r2.json"]);
    // A prefix that ends mid-name matches sibling folders too, as before.
    expect(await s.list("transcripts/a")).toEqual(["transcripts/a/r1.fix.json", "transcripts/a/r1.json", "transcripts/a/sub/r2.json", "transcripts/ab/r3.json"]);
    expect(await s.list("transcripts/a/r1.f")).toEqual(["transcripts/a/r1.fix.json"]);
    expect(await s.list("")).toEqual([...KEYS].sort());
    expect(await s.list("t")).toEqual(["top.json", "transcripts/a/r1.fix.json", "transcripts/a/r1.json", "transcripts/a/sub/r2.json", "transcripts/ab/r3.json", "transcripts/b/r4.json"]);
  });

  it("returns [] for a folder that does not exist, a file used as a folder, or a prefix outside the root", async () => {
    const { s } = await storage(KEYS);
    expect(await s.list("transcripts/none/")).toEqual([]);
    expect(await s.list("top.json/x")).toEqual([]);
    expect(await s.list("../")).toEqual([]);
  });

  it("walks only the prefix's folder, not the whole root", async () => {
    const { s, root } = await storage(KEYS);
    vi.mocked(fsp.readdir).mockClear();
    await s.list("transcripts/a/r1.");
    expect(vi.mocked(fsp.readdir).mock.calls.map((c) => c[0])).toEqual([join(root, "transcripts", "a")]);
  });
});
