import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { commentEvent } from "../src/core/comment-event.js";
import type { SourceRef } from "../src/core/types.js";
import type { ExternalIdentity } from "../src/interfaces/auth-provider.js";

// The comment-to-event mapping has one copy, in core (issue #282): the command inbox reader and the Slack source
// import it, and no copy remains under src/impl.

const ROOT = join(import.meta.dirname, "..");

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? tsFiles(p) : p.endsWith(".ts") ? [p] : [];
  });
}

describe("comment event mapping", () => {
  it("lives in src/core only, and the GitHub-free readers import it from there", () => {
    expect(existsSync(join(ROOT, "src/impl/source/comment-event.ts"))).toBe(false);
    // The mapping's signature line (GitHub's own reader, with PR targets, is another shape). Only one file holds it.
    const holders = tsFiles(join(ROOT, "src"))
      .filter((f) => /kind: "spec_approved", source, comment_id, approver: who, note: t }/.test(readFileSync(f, "utf8")))
      .map((f) => relative(ROOT, f));
    expect(holders).toEqual(["src/core/comment-event.ts"]);
    expect(readFileSync(join(ROOT, "src/impl/source/slack-source.ts"), "utf8")).toContain('from "../../core/comment-event.js"');
    expect(readFileSync(join(ROOT, "src/core/command-inbox.ts"), "utf8")).toContain('from "./comment-event.js"');
  });

  it("maps a command, an unknown word and a plain comment", () => {
    const source: SourceRef = { type: "local", id: "local-1", link: "local:local-1" };
    const who: ExternalIdentity = { provider: "local", subject: "alice" };
    expect(commentEvent(source, "c1", who, "/approve ok")).toEqual({ kind: "spec_approved", source, comment_id: "c1", approver: who, note: "ok" });
    expect(commentEvent(source, "c2", who, "/frobnicate")).toEqual({ kind: "unknown_command", source, comment_id: "c2", requester: who, command: "frobnicate" });
    expect(commentEvent(source, "c3", who, "hello")).toEqual({ kind: "plain_comment", source, comment_id: "c3", author: who, body: "hello" });
  });
});
