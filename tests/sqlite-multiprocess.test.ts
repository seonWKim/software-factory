import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { SystemClock } from "../src/impl/clock/system-clock.js";
import { SqlFactoryStore } from "../src/impl/store/sql/sql-factory-store.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
import { issue, system } from "./helpers/store.js";

// Several OS processes on one SQLite file: the single-node shape of "N workers, pull-based claims".
// Children import the compiled store, so this builds first.

const ROOT = resolve(import.meta.dirname, "..");
const PROCESSES = 4;
const RUNS = 40;

const child = (dist: string, db: string) => `
  const { SqlFactoryStore } = await import(${JSON.stringify(pathToFileURL(join(dist, "impl/store/sql/sql-factory-store.js")).href)});
  const { SqliteDriver } = await import(${JSON.stringify(pathToFileURL(join(dist, "impl/store/sqlite/sqlite-driver.js")).href)});
  const { SystemClock } = await import(${JSON.stringify(pathToFileURL(join(dist, "impl/clock/system-clock.js")).href)});
  const store = new SqlFactoryStore(new SqliteDriver(${JSON.stringify(db)}), new SystemClock());
  const claimed = [];
  for (;;) {
    const run = await store.claimRun({ worker_id: "p" + process.pid, kinds: ["triage"], lease_ms: 60000 });
    if (!run) break;
    claimed.push(run.id);
    await store.completeRun(run.id, run.lease.token, { status: "succeeded", summary: "", data: {} });
  }
  process.stdout.write(JSON.stringify(claimed));
`;

function runChild(code: string): Promise<string[]> {
  return new Promise((ok, fail) => {
    const p = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", code]);
    let out = "";
    let err = "";
    p.stdout.on("data", (d: Buffer) => (out += d));
    p.stderr.on("data", (d: Buffer) => (err += d));
    p.on("close", (c) => (c === 0 ? ok(JSON.parse(out) as string[]) : fail(new Error(err))));
  });
}

describe("SqlFactoryStore on SQLite across processes", () => {
  let dist: string;
  beforeAll(() => {
    dist = mkdtempSync(join(tmpdir(), "sf-dist-"));
    execFileSync(process.execPath, [join(ROOT, "node_modules/typescript/bin/tsc"), "-p", join(ROOT, "tsconfig.json"), "--outDir", dist]);
  }, 60_000);

  it("every run is claimed exactly once", async () => {
    const db = join(mkdtempSync(join(tmpdir(), "sf-mp-")), "factory.db");
    const store = new SqlFactoryStore(new SqliteDriver(db), new SystemClock());
    await store.migrate();
    for (let i = 0; i < RUNS; i++) {
      await store.createWorkItem(issue(i), system, { enqueue: { kind: "triage", idempotency_key: `k${i}` } });
    }

    const results = await Promise.all(Array.from({ length: PROCESSES }, () => runChild(child(dist, db))));
    const all = results.flat();
    expect(all).toHaveLength(RUNS);
    expect(new Set(all).size).toBe(RUNS);
    expect(await store.listUnacknowledgedRuns(RUNS + 1)).toHaveLength(RUNS);
    await store.close();
  }, 60_000);
});
