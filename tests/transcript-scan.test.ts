import { describe, expect, it } from "vitest";
import { pipeline } from "./helpers/fakes.js";

// G5 on transcripts (docs/architecture.md §5): a known secret value or the canary fails the run; a pattern hit
// alone, such as a token-shaped test fixture that a failing test printed, only keeps the transcript out of storage.

/** Token-shaped, built here so this file holds no literal the scanner flags. */
const TOKEN = `ghp_${"Ab3".repeat(12)}`;

describe("transcript scan", () => {
  it("a token-shaped string in the transcript does not fail the run; the transcript is not stored", async () => {
    const f = await pipeline({
      implement: () => ({ output: { summary: "s", next_steps: "n" }, transcript: `expected '${TOKEN}' to be null` }),
    });
    const item = await f.submit();
    await f.step();

    const [impl] = await f.runs(item, "implement");
    expect(impl!.status).toBe("succeeded");
    expect(f.broker.calls.some((c) => c.name === "forge.push_branch")).toBe(true);
    const warned = f.log.lines.find((l) => l.msg === "transcript not stored: the egress scan flagged it");
    expect(warned?.fields).toMatchObject({ run_id: impl!.id, rules: "github_token" });
    expect(JSON.stringify(f.log.lines)).not.toContain(TOKEN);
    expect(JSON.stringify(await f.store.listRuns(item.id))).not.toContain(TOKEN);
  });
});
