## Finding

src/core/batch.ts: `chunks` throws on an empty list because it reads `items[0]` before the loop.
