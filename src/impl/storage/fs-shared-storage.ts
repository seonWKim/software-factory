import { mkdir, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { SharedStorage, StorageRange } from "../../interfaces/shared-storage.js";

export class FsSharedStorage implements SharedStorage {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return await readFile(this.path(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  /** Reads only bytes `[start, end)` (clamped to the file's size) through one file handle; never the whole file. */
  async getRange(key: string, start: number, end: number): Promise<StorageRange | null> {
    let fh;
    try {
      fh = await open(this.path(key), "r");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    try {
      const size = (await fh.stat()).size;
      const s = Math.min(Math.max(0, Math.floor(start)), size);
      const e = Math.min(Math.max(s, Math.floor(end)), size);
      const bytes = new Uint8Array(e - s);
      let done = 0;
      while (done < bytes.length) {
        const { bytesRead } = await fh.read(bytes, done, bytes.length - done, s + done);
        if (bytesRead === 0) break;
        done += bytesRead;
      }
      return { bytes: bytes.subarray(0, done), size };
    } finally {
      await fh.close();
    }
  }

  /**
   * Every key that starts with `prefix`, sorted. Walks only the folder the prefix names (its part up to the last `/`),
   * never the whole root: one item's transcripts cost one item's files, however many items the root holds.
   */
  async list(prefix: string): Promise<string[]> {
    const cut = prefix.lastIndexOf("/");
    const dir = cut <= 0 ? this.root : resolve(this.root, prefix.slice(0, cut));
    if (dir !== this.root && !dir.startsWith(this.root + sep)) return [];
    try {
      const entries = await readdir(dir, { recursive: true, withFileTypes: true });
      return entries
        .filter((e) => e.isFile())
        .map((e) => relative(this.root, join(e.parentPath, e.name)).split(sep).join("/"))
        .filter((k) => k.startsWith(prefix))
        .sort();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return [];
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }

  private path(key: string): string {
    const path = resolve(this.root, key);
    if (!path.startsWith(this.root + sep)) throw new Error(`storage key escapes root: ${key}`);
    return path;
  }
}
