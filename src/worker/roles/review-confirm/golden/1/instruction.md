## Finding

src/core/batch.ts: `chunks` drops the last partial chunk: the loop runs while `i + size < items.length`, so 5 items in chunks of 2 give [[a,b],[c,d]] and lose e.
