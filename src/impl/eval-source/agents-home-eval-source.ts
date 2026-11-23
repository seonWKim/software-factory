// The `agents-home` SkillEvalSource (docs/plugins/skill-eval-source.md): the owner's golden cases, read through
// `<home>/bin/golden`, where the home is AGENTS_HOME, else ~/.agents. Only `golden show` runs (the form its --help
// gave on 2026-11-24): `golden show --status active --tags <tag>` lists the skill's active cases, one JSON object per
// line, and `golden show <G-id>` prints one case with its `body.input` and `body.expected`. The tag is the skill
// ref's last path segment (`skills/tests-first` → `tests-first`). Each value is its own argv item, nothing goes
// through a shell, and each call stops after 30 seconds. Nothing is written under the home.

import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type SkillEvalSource, type SkillEvalSourceCase, SkillEvalSourceUnavailable } from "../../interfaces/skill-eval-source.js";

/** The CLI the source runs, relative to the home. */
export const GOLDEN_CLI = "bin/golden";
/** How long one CLI call may take before it is stopped and counted as a failure. */
export const GOLDEN_CLI_TIMEOUT_MS = 30_000;
/** The status of a case the owner promoted; only those are imported. */
const ACTIVE = "active";

/** The agents home: AGENTS_HOME when set, else `~/.agents`. */
export function evalSourceHome(env: Readonly<Record<string, string | undefined>>, home: string = homedir()): string {
  const set = env.AGENTS_HOME?.trim();
  return set ? set : join(home, ".agents");
}

/** The golden tag of a skill ref: its last path segment. Null when that is empty or holds a comma (golden splits tags on commas). */
export function skillTag(skill: string): string | null {
  const tag = skill.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  return tag.trim() === "" || tag.includes(",") ? null : tag;
}

const isRunnable = (file: string): boolean => {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export class AgentsHomeEvalSource implements SkillEvalSource {
  readonly enabled = true;
  readonly home: string;

  constructor(env: Readonly<Record<string, string | undefined>>, home: string = homedir(), private readonly timeout_ms: number = GOLDEN_CLI_TIMEOUT_MS) {
    this.home = evalSourceHome(env, home);
  }

  async listCases(skill: string): Promise<readonly SkillEvalSourceCase[]> {
    const tag = skillTag(skill);
    if (tag === null) throw new SkillEvalSourceUnavailable(`${JSON.stringify(skill)} gives no golden tag (its last path segment is empty or holds a comma)`);
    if (!isRunnable(join(this.home, GOLDEN_CLI))) throw new SkillEvalSourceUnavailable(`no executable ${GOLDEN_CLI} in the agents home ${this.home}`);
    const ids: string[] = [];
    for (const line of (await this.golden(["show", "--status", ACTIVE, "--tags", tag])).split("\n")) {
      if (line.trim() === "") continue;
      const rec = parse(line);
      const id = isObject(rec) ? rec.id : undefined;
      if (typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id)) throw new SkillEvalSourceUnavailable("golden show printed a line that is no case with an id");
      if (!ids.includes(id)) ids.push(id);
    }
    const out: SkillEvalSourceCase[] = [];
    for (const id of ids) {
      const shown = parse(await this.golden(["show", id]));
      const body = isObject(shown) ? shown.body : undefined;
      if (!isObject(body) || body.input === undefined) throw new SkillEvalSourceUnavailable(`golden show ${id} printed no case body with an input`);
      out.push({ id, input: body.input, expected: body.expected });
    }
    return out;
  }

  /** Runs `<home>/bin/golden <args>` in the home with a clean environment; its stdout, or a throw naming the call. */
  private golden(args: readonly string[]): Promise<string> {
    const env: Record<string, string> = { LANG: process.env.LANG ?? "C.UTF-8", AGENTS_HOME: this.home };
    for (const key of ["PATH", "HOME", "TMPDIR"]) if (process.env[key]) env[key] = process.env[key]!;
    return new Promise((resolve, reject) => {
      execFile(join(this.home, GOLDEN_CLI), [...args], { cwd: this.home, env, timeout: this.timeout_ms, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" }, (err, stdout) => {
        if (!err) return resolve(stdout);
        const how = err.killed ? `stopped after ${this.timeout_ms} ms` : `exit ${String(err.code ?? "unknown")}`;
        reject(new SkillEvalSourceUnavailable(`golden ${args[0] ?? ""} failed (${how})`));
      });
    });
  }
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
