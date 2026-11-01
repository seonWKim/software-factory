import { type ResolvedGuard, Refusal, capped, checkPath, defineTool, helper, isDenied, str } from "./guard.js";
import { basename, isUnder, relativeTo } from "./paths.js";
import type { ToolContext } from "./types.js";

/**
 * Glob pattern → RegExp over a `/`-separated relative path. `**` spans folders (`**\/` may match none),
 * `*` and `?` stay within one segment, `{a,b}` is alternation, `[...]` a character class.
 */
export function globToRegExp(pattern: string): RegExp {
  let re = "";
  let braces = 0;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        const slash = pattern[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      braces++;
      re += "(?:";
    } else if (c === "}" && braces > 0) {
      braces--;
      re += ")";
    } else if (c === "," && braces > 0) re += "|";
    else if (c === "[") {
      const end = pattern.indexOf("]", i + 2);
      if (end === -1) re += "\\[";
      else {
        let cls = pattern.slice(i + 1, end).replace(/\\/g, "\\\\");
        if (cls.startsWith("!")) cls = `^${cls.slice(1)}`;
        re += `[${cls}]`;
        i = end;
      }
    } else re += c.replace(/[.+^$()|\\\]{}]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/**
 * Regular files under `root` (canonical, already checked), not following symlinks, skipping `.git`, and
 * dropping every file under a denied path. Symlinks are never listed, so nothing is reached through one.
 */
async function listFiles(ctx: ToolContext, root: string, guard: ResolvedGuard): Promise<string[]> {
  const r = await helper(ctx, ["find", root, "-name", ".git", "-prune", "-o", "-type", "f", "-print0"]);
  if (r.timed_out || (r.exit_code !== 0 && r.stdout === "")) throw new Error(`cannot list ${root}: ${r.stderr.trim()}`);
  return r.stdout
    .split("\0")
    .filter((p) => p !== "" && isUnder(p, root) && !isDenied(guard, p))
    .sort();
}

function searchRoot(input: Record<string, unknown>): string {
  return str(input, "path", false) ?? ".";
}

export const Glob = defineTool({
  name: "Glob",
  description:
    "List files whose path relative to `path` (default: the workdir) matches a glob pattern, e.g. `**/*.ts` or `src/*.{js,ts}`. One absolute path per line.",
  input_schema: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string", description: "Folder to search; absolute or relative to the workdir" },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  capability: "read",
  async run(input, ctx) {
    const pattern = str(input, "pattern", true);
    const { path: root, guard } = await checkPath(ctx, searchRoot(input));
    const re = globToRegExp(pattern);
    const files = (await listFiles(ctx, root, guard)).filter((f) => re.test(relativeTo(f, root)));
    return capped(ctx, files.join("\n"));
  },
});

const GREP_BATCH = 200;

export const Grep = defineTool({
  name: "Grep",
  description:
    "Search file contents with an extended regular expression under `path` (default: the workdir). Returns `file:line:text`, or file names with output_mode `files_with_matches`. `glob` filters files (by name, or by relative path if it has a `/`).",
  input_schema: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string", description: "Folder or file to search; absolute or relative to the workdir" },
      glob: { type: "string" },
      ignore_case: { type: "boolean" },
      output_mode: { type: "string", enum: ["content", "files_with_matches"] },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  capability: "read",
  async run(input, ctx) {
    const pattern = str(input, "pattern", true);
    const glob = str(input, "glob", false);
    const mode = str(input, "output_mode", false) ?? "content";
    if (mode !== "content" && mode !== "files_with_matches") throw new Refusal("output_mode must be content or files_with_matches");
    const { path: root, guard } = await checkPath(ctx, searchRoot(input));
    let files = await listFiles(ctx, root, guard);
    if (glob !== undefined) {
      const re = globToRegExp(glob);
      files = files.filter((f) => re.test(glob.includes("/") ? relativeTo(f, root) : basename(f)));
    }
    const flags = ["-E", "-I", "-H", mode === "content" ? "-n" : "-l", ...(input.ignore_case === true ? ["-i"] : [])];
    const out: string[] = [];
    let size = 0;
    for (let i = 0; i < files.length && size <= ctx.policy.output_cap; i += GREP_BATCH) {
      // Only files that passed the deny filter are named; grep reads nothing else.
      const r = await helper(ctx, ["grep", ...flags, "-e", pattern, "--", ...files.slice(i, i + GREP_BATCH)]);
      if (r.timed_out || (r.exit_code !== 0 && r.exit_code !== 1 && r.stdout === "")) {
        throw new Error(`grep failed: ${r.stderr.trim()}`);
      }
      if (r.stdout) {
        out.push(r.stdout.endsWith("\n") ? r.stdout.slice(0, -1) : r.stdout);
        size += r.stdout.length;
      }
    }
    return capped(ctx, out.join("\n"));
  },
});
