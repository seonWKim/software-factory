// Transcripts, logs, the read-only shared pool. First impl: local filesystem; later PV / PVC.

/** One byte range of a stored file, and the file's whole size. */
export interface StorageRange {
  /** Bytes `[start, end)` of the file, clamped to its size; fewer than asked only at the end of the file. */
  bytes: Uint8Array;
  /** The file's size in bytes, so a caller can page from either end without reading the file. */
  size: number;
}

export interface SharedStorage {
  put(key: string, data: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  list(prefix: string): Promise<string[]>;
  delete(key: string): Promise<void>;
  /**
   * Bytes `[start, end)` of `key` and its size, reading only that range (the status page's transcript view,
   * design §9); null when the key is missing. `getRange(key, 0, 0)` gives the size and no bytes. Optional, so an
   * older implementation still builds: without it a caller falls back to `get` (see `readRange`).
   */
  getRange?(key: string, start: number, end: number): Promise<StorageRange | null>;
}

/**
 * `storage.getRange` when the implementation has it; otherwise the whole file through `get`, cut to the range.
 * Only the fallback reads more than the range.
 */
export async function readRange(storage: SharedStorage, key: string, start: number, end: number): Promise<StorageRange | null> {
  if (storage.getRange) return storage.getRange(key, start, end);
  const all = await storage.get(key);
  if (!all) return null;
  const s = Math.min(Math.max(0, start), all.length);
  return { bytes: all.subarray(s, Math.max(s, Math.min(end, all.length))), size: all.length };
}
