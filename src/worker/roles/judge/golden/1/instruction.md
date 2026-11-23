## Goal lines

- Outbound sends its writes in chunks of at most 20, in order.
- No item is lost: every queued write is sent exactly once.

## Recorded phases

1. Send outbound writes through one batch helper
2. Add the chunks helper (this phase, just closed) (last)

## This phase: phase 2 of 2

Title: Add the chunks helper

Merge sha: 5b1e7f3c2a9d4e8f6b0a1c3d5e7f9a2b4c6d8e0f

### Problem

Outbound needs a helper that splits a list of writes into chunks of a given size, in order.

### Done criteria

- src/core/batch.ts exports chunks(items, size).
- Every item is in exactly one chunk, in order.
