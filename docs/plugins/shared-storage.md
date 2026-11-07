# SharedStorage

What it does: blobs shared between processes (transcripts, logs, the read-only shared pool), under keys.

Interface methods: `put(key, data)`, `get(key)` (the whole file), `list(prefix)`, `delete(key)`, and, since
2026-11-07 (issue #303), `getRange(key, start, end)` → `{ bytes, size }`: bytes `[start, end)` and the file's size,
reading only that range (the status page's transcript view pages a transcript through it). `getRange` is
optional; without it `readRange` in `src/interfaces/shared-storage.ts` falls back to `get` and cuts the range.

Plugins:

- `fs`: `FsSharedStorage`, files under `<state_dir>/storage` (a deny path for agents). Implements `getRange` with one
  file handle (`open`, `stat`, positioned `read`).
  - Enable: `"plugins": { "storage": "fs", ... }`. Secrets: none. Settings: `state_dir`.

Switch back / disable: `"storage": "fs"`.

## History

- **Byte-range read** (added 2026-11-07, issue #303). Before: the interface read only whole files (`get`).
