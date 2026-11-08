import { describe, expect, it } from "vitest";
import { codeOnly, read, sourceFiles } from "./lib.js";

// RFC 0015 §8 `passport` (owner decision 2026-11-08): the passport service's `narrow` is called only from
// src/worker/ (run passports) and src/identity/ (itself). It is never exposed as a tool, an HTTP route or a CLI
// command, which would let a holder mint passports at will. No ratchet: there is no exemption.

const ALLOWED = [/^worker\//, /^identity\//];

/** A call or a reference to a member named `narrow`: `x.narrow(`, `x?.narrow(`, `x["narrow"]`, `{ narrow } = x`. */
const NARROW = /(?:\?\.|\.)\s*narrow\b|\[\s*["'`]narrow["'`]\s*\]|\{[^}]*\bnarrow\b[^}]*\}\s*=/g;

/** Every `<file>:<line>` outside the allowed folders that reaches `narrow`. */
export function narrowViolations(files: readonly { path: string; text: string }[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    if (ALLOWED.some((a) => a.test(f.path))) continue;
    const code = codeOnly(f.text);
    for (const m of code.matchAll(NARROW)) out.push(`${f.path}:${code.slice(0, m.index).split("\n").length}`);
  }
  return out;
}

describe("passport", () => {
  it("narrow is called only from worker/ and identity/", () => {
    expect(narrowViolations(sourceFiles().map((path) => ({ path, text: read(path) })))).toEqual([]);
  });

  it("flags a call from a CLI command, a tool, an HTTP route or legacy code (negative fixture)", () => {
    const fixtures = [
      { path: "cli/handlers/mint/mint.command.ts", text: "const svc = identity();\nawait svc.narrow(id, { kind: \"run\" });\n" },
      { path: "core/tools/mint.ts", text: "export const tool = (s) => s?.narrow(p, req);\n" },
      { path: "ui/api.ts", text: "route('/mint', (s) => s[\"narrow\"](p, req));\n" },
      { path: "impl/broker/mint.ts", text: "const { narrow } = svc;\n" },
    ];
    expect(narrowViolations(fixtures)).toEqual(["cli/handlers/mint/mint.command.ts:2", "core/tools/mint.ts:1", "ui/api.ts:1", "impl/broker/mint.ts:1"]);
  });

  it("allows worker/ and identity/, and ignores comments and other names", () => {
    const fixtures = [
      { path: "worker/engine/run.ts", text: "await passports.narrow(id, { kind: \"run\" });\n" },
      { path: "identity/passport/service.ts", text: "async narrow(p, r) { return this.narrow(p, r); }\n" },
      { path: "cli/handlers/x/x.command.ts", text: "// svc.narrow(id) is not allowed here\nnarrowRestrictions(a, b);\nconst narrowed = 1;\n" },
    ];
    expect(narrowViolations(fixtures)).toEqual([]);
  });
});
