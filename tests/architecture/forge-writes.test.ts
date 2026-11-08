import { describe, expect, it } from "vitest";
import { codeOnly, ratchet, read, sourceFiles } from "./lib.js";

// RFC 0015 §11 M7: no forge or source write outside src/outbound/. A write is a call of a source adapter's or the
// forge's write method (a comment, a reaction, a label, a close, a filed issue, a PR close, a base push), or a
// broker call of a GitHub write tool (push, open PR, comment). The plugin implementations (src/impl/) define them,
// and src/interfaces/ declares them. The controller's outbox unit only stores intents: its own operations
// (`markSeen`, `setStatus` on `unit("outbox")` or `this`) are not writes.
//
// Ratchet: empty since M7's last write, the controller's sub-issue filing, moved to outbound (`file_sub_issue`).

const WRITE_METHOD = /([\w$)\]"]+)\s*\.\s*(postComment|markSeen|setStatus|closeIssue|fileSubIssue|fileIssue|postPrComment|setPrStatus|closePr|pushBase|push)\s*\(/g;
const BROKER_WRITE = /\.call\(\s*\w+\s*,\s*"github\.(push_branch|open_pr|comment|close_pr|merge_pr)"/g;
const EXEMPT = /^(?:outbound|impl|interfaces)\//;

function violations(): string[] {
  const out: string[] = [];
  for (const file of sourceFiles()) {
    if (EXEMPT.test(file)) continue;
    const code = codeOnly(read(file));
    for (const m of code.matchAll(WRITE_METHOD)) {
      const receiver = m[1]!;
      // The outbox unit's own operations store intents; `this.x(` is a method of the caller's own class.
      if (receiver === "this" || receiver.endsWith('"outbox")') || receiver === ")") continue;
      // Array pushes are no git push.
      if (m[2] === "push" && !/pusher$/i.test(receiver)) continue;
      out.push(`write|${file}|${m[2]}`);
    }
    for (const m of code.matchAll(BROKER_WRITE)) out.push(`broker-write|${file}|github.${m[1]}`);
  }
  return out;
}

describe("forge-writes", () => {
  it("no forge or source write outside src/outbound/ (ratchet)", () => {
    ratchet("forge-writes", violations());
  });

  it("catches an adapter write, a forge write and a broker push, and lets the outbox unit's own calls pass", () => {
    const find = (code: string) => [...code.matchAll(WRITE_METHOD)].map((m) => m[1]);
    expect(find("await adapter.closeIssue(it.source)")).toEqual(["adapter"]);
    expect(find("await this.c.k.forge.setPrStatus(s, st, 1)")).toEqual(["forge"]);
    expect(find('await this.c.unit("outbox").markSeen(e.source, null)')).toEqual(['"outbox")']);
    expect([...'await broker.call(ctx, "github.push_branch", {})'.matchAll(BROKER_WRITE)]).toHaveLength(1);
  });
});
