// Transcripts, logs, the read-only shared pool. First impl: local filesystem; later PV / PVC.

export interface SharedStorage {
  put(key: string, data: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  list(prefix: string): Promise<string[]>;
  delete(key: string): Promise<void>;
}
