import { Refusal, capped, checkPath, defineTool, helper, int, str } from "./guard.js";
import type { ToolContext } from "./types.js";

async function readFile(ctx: ToolContext, path: string): Promise<string> {
  const r = await helper(ctx, ["cat", "--", path]);
  if (r.exit_code !== 0 || r.timed_out) throw new Error(`cannot read ${path}: ${r.stderr.trim()}`);
  return r.stdout;
}

// Writes stdin to "$1", creating its folder. The path is an argument, never part of the script.
const WRITE_SCRIPT = 'd=${1%/*}; [ -n "$d" ] || d=/; mkdir -p -- "$d" && cat > "$1"';

async function writeFile(ctx: ToolContext, path: string, content: string): Promise<void> {
  const r = await helper(ctx, ["/bin/sh", "-c", WRITE_SCRIPT, "sh", path], content);
  if (r.exit_code !== 0 || r.timed_out) throw new Error(`cannot write ${path}: ${r.stderr.trim()}`);
}

export const Read = defineTool({
  name: "Read",
  description:
    "Read a file in the workdir or a writable path. Returns lines numbered from 1 (`n<TAB>line`). Optional offset (first line, 1-based) and limit (number of lines).",
  input_schema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute, or relative to the workdir" },
      offset: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 0 },
    },
    required: ["file_path"],
    additionalProperties: false,
  },
  capability: "read",
  async run(input, ctx) {
    const file = str(input, "file_path", true);
    const offset = int(input, "offset");
    const limit = int(input, "limit");
    const { path } = await checkPath(ctx, file);
    const text = await readFile(ctx, path);
    if (text === "") return { ok: true, content: "" };
    const lines = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
    const start = Math.max(1, offset ?? 1);
    const picked = lines.slice(start - 1, limit === undefined ? undefined : start - 1 + limit);
    return capped(ctx, picked.map((l, i) => `${start + i}\t${l}`).join("\n"));
  },
});

export const Write = defineTool({
  name: "Write",
  description: "Write a whole file in the workdir or a writable path, creating folders. Overwrites an existing file.",
  input_schema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute, or relative to the workdir" },
      content: { type: "string" },
    },
    required: ["file_path", "content"],
    additionalProperties: false,
  },
  capability: "write",
  async run(input, ctx) {
    const file = str(input, "file_path", true);
    const content = str(input, "content", false);
    if (content === undefined) throw new Refusal("content must be a string");
    const { path } = await checkPath(ctx, file);
    await writeFile(ctx, path, content);
    return { ok: true, content: `wrote ${content.length} characters to ${path}` };
  },
});

export const Edit = defineTool({
  name: "Edit",
  description:
    "Replace old_string with new_string in a file. old_string must occur exactly once unless replace_all is true.",
  input_schema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute, or relative to the workdir" },
      old_string: { type: "string" },
      new_string: { type: "string" },
      replace_all: { type: "boolean" },
    },
    required: ["file_path", "old_string", "new_string"],
    additionalProperties: false,
  },
  capability: "write",
  async run(input, ctx) {
    const file = str(input, "file_path", true);
    const oldString = str(input, "old_string", true);
    const newString = str(input, "new_string", false);
    if (newString === undefined) throw new Refusal("new_string must be a string");
    if (newString === oldString) throw new Refusal("old_string and new_string are the same");
    const replaceAll = input.replace_all === true;
    // Checked as a write before anything is read, so a refused target's content is never loaded.
    const { path } = await checkPath(ctx, file);
    const text = await readFile(ctx, path);
    const count = text.split(oldString).length - 1;
    if (count === 0) throw new Refusal(`old_string not found in ${file}`);
    if (count > 1 && !replaceAll) throw new Refusal(`old_string occurs ${count} times in ${file}; set replace_all or add context`);
    const next = replaceAll ? text.split(oldString).join(newString) : text.replace(oldString, () => newString);
    await writeFile(ctx, path, next);
    return { ok: true, content: `replaced ${replaceAll ? count : 1} occurrence(s) in ${path}` };
  },
});
