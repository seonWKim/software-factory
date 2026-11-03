# SharedStorage

What it does: blobs shared between processes (transcripts, logs, the read-only shared pool), under keys.

Plugins:

- `fs`: `FsSharedStorage`, files under `<state_dir>/storage` (a deny path for agents).
  - Enable: `"plugins": { "storage": "fs", ... }`. Secrets: none. Settings: `state_dir`.

Switch back / disable: `"storage": "fs"`.

## History

No earlier decision is recorded for this topic.
