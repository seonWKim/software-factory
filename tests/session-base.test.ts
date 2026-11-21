import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FactoryConfig } from "../src/core/config.js";
import { Sessions } from "../src/core/session.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { NoOpSandbox } from "../src/impl/sandbox/noop-sandbox.js";
import { STORE_BRANCH } from "../src/interfaces/tool-broker.js";
import { FakeBroker } from "./helpers/fakes/broker.js";
import { FakeAuth, FakeIssues, MemorySessionFiles } from "./helpers/fakes/runner.js";
import { alice, cleanScanner, config, silent } from "./helpers/fakes/config.js";
import { git } from "./helpers/git-fixture.js";
import { issue, newStore, system } from "./helpers/store.js";

// `interactive finish` after the session absorbed a newer base (bug of 2026-11-21, wi_7391c26f): over a real git
// repo and the local sandbox, the gates diff against the base HEAD already contains, so the files only the base
// changed are not counted, and the session's own changes, an edit inside the merge commit included, still are.

const write = (dir: string, files: Record<string, string>) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
};
const commit = (dir: string, files: Record<string, string>, msg: string) => {
  write(dir, files);
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", msg);
};

/** A local item allowed `src/a/`, an open session on it, and main moved on in `src/b/` after the session started. */
async function absorbed() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sf-session-base-")));
  const repo = join(root, "repo");
  git(root, "init", "--quiet", "-b", "main", repo);
  commit(repo, { "src/a/x.ts": "a\n", "src/b/y.ts": "b\n", "src/b/w.ts": "w\n" }, "init");
  const cfg: FactoryConfig = { ...config, repo: { ...config.repo, path: repo, test_command: ["sh", "-c", "exit 0"] } };
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const sandbox = new NoOpSandbox(join(root, "wt"), undefined, undefined, { local: true });
  const broker = new FakeBroker();
  broker.tools = broker.tools.filter((t) => t.name === STORE_BRANCH);
  broker.toForge = false;
  const s = new Sessions({
    store, sandbox, broker: new FakeBroker(), scanner: cleanScanner, auth: new FakeAuth(), clock, config: cfg, log: silent,
    files: new MemorySessionFiles(), issues: new FakeIssues({}), toolEnv: {}, owner: "session:host:1", local: { broker, sandbox },
  });
  const { item } = await store.createWorkItem({ ...issue(1), source: { type: "local", id: "local:1", link: "" } }, system);
  const r = await store.transition({ id: item.id, expected_version: 1, actor: system, reason: "seed", patch: { stage: "RUNNING", allowed_paths: ["src/a/"], tier: 2, done_criteria: ["x"] } });
  expect(r.ok).toBe(true);
  const started = await s.start({ target: item.id, person: alice });
  expect(started.ok).toBe(true);
  const wd = started.file!.folder.workdir;
  // Other items merged into main meanwhile, outside this item's allowed_paths.
  commit(repo, { "src/b/y.ts": "b2\n", "src/b/w.ts": "w2\n" }, "another item");
  commit(wd, { "src/a/x.ts": "a2\n" }, "the item's change");
  const merge = (...extra: string[]) => {
    git(wd, "fetch", "--quiet", repo, "main");
    git(wd, "merge", "--quiet", "--no-ff", ...extra, "-m", "merge main", "FETCH_HEAD");
  };
  return { s, wd, repo, broker, merge };
}

describe("interactive finish after the session absorbed a newer base", () => {
  it("passes when the branch merged main and its own changes are in scope", async () => {
    const h = await absorbed();
    h.merge();
    const done = await h.s.finish({});
    expect(done.lines.join("\n")).not.toContain("refused");
    expect(done.ok).toBe(true);
    expect(h.broker.stores.map((c) => c.name)).toEqual([STORE_BRANCH]);
  });

  it("passes when the branch was rebased onto main", async () => {
    const h = await absorbed();
    git(h.wd, "fetch", "--quiet", h.repo, "main");
    git(h.wd, "rebase", "--quiet", "FETCH_HEAD");
    expect((await h.s.finish({})).ok).toBe(true);
  });

  it("is refused for the session's own commit outside allowed_paths, naming only that file", async () => {
    const h = await absorbed();
    h.merge();
    commit(h.wd, { "src/c/z.ts": "z\n" }, "out of scope");
    const done = await h.s.finish({});
    expect(done.ok).toBe(false);
    expect(done.lines).toContain("- scope: files outside allowed_paths: src/c/z.ts");
    expect(h.broker.stores).toEqual([]);
  });

  it("is refused for an out-of-scope edit made inside the merge commit itself", async () => {
    const h = await absorbed();
    h.merge("--no-commit");
    write(h.wd, { "src/b/y.ts": "b2, resolved differently\n" }); // a file main changed, edited in the resolution
    git(h.wd, "add", "-A");
    git(h.wd, "commit", "--quiet", "--no-edit");
    const done = await h.s.finish({});
    expect(done.ok).toBe(false);
    expect(done.lines).toContain("- scope: files outside allowed_paths: src/b/y.ts");
    expect(h.broker.stores).toEqual([]);
  });
});
