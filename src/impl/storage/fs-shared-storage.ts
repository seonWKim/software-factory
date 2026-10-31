import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { SharedStorage } from "../../interfaces/shared-storage.js";

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

  async list(prefix: string): Promise<string[]> {
    try {
      const entries = await readdir(this.root, { recursive: true, withFileTypes: true });
      return entries
        .filter((e) => e.isFile())
        .map((e) => relative(this.root, join(e.parentPath, e.name)).split(sep).join("/"))
        .filter((k) => k.startsWith(prefix))
        .sort();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
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
