// The project's Node major for the merge check: install and checks run on the Node the project names (`.nvmrc`,
// else `package.json` engines.node), as CI does, not on whatever Node the factory runs. The runtime is looked up
// inside the run folder's sandbox (one probe command, no network, nothing installed): the worker's own `node` when
// its major matches, else a matching install from nvm, fnm, Volta or Homebrew. None found fails the run with
// checks_env naming the version needed and the one found; it never passes silently on another Node.

import { RunFailure } from "../../support.js";
import type { RunCall } from "../../run-kind.js";
import type { Worker } from "../../runner.js";

type SandboxHandle = NonNullable<RunCall["handle"]>;
/** core/policy.ts CHECKS_ENV, spelled out so this component adds no import from a legacy folder. */
const CHECKS_ENV = "checks_env";

/** Where the project's Node major came from. */
export interface NodeWant {
  major: string;
  from: ".nvmrc" | "package.json engines";
}

/** The Node the checks run on: `bin` null is the worker's own `node` (already on PATH). */
export interface NodeChoice {
  bin: string | null;
  version: string;
}

/** The leading major of `v22`, `22.13.0`, `>=22.13` or `^22 || ^24` (the first one named); null when none. */
export function nodeMajor(text: string, loose: boolean): string | null {
  const t = text.trim().split("\n")[0]!.trim();
  const m = loose ? /(\d+)/.exec(t) : /^v?(\d+)(?:\.|$)/.exec(t);
  return m ? String(Number(m[1])) : null;
}

/** A file of the merged commit, or null when it is not there. */
async function readAt(w: Worker, handle: SandboxHandle, sha: string, path: string): Promise<string | null> {
  const r = await w.gitRaw(handle, ["cat-file", "blob", `${sha}:${path}`]);
  return r.exit_code === 0 ? r.stdout : null;
}

/** The project's Node major: `.nvmrc` first, then `package.json` engines.node; null when neither names one. */
export async function projectNode(w: Worker, handle: SandboxHandle, sha: string): Promise<NodeWant | null> {
  const nvmrc = await readAt(w, handle, sha, ".nvmrc");
  const fromNvmrc = nvmrc === null ? null : nodeMajor(nvmrc, false);
  if (fromNvmrc) return { major: fromNvmrc, from: ".nvmrc" };
  const pkg = await readAt(w, handle, sha, "package.json");
  if (pkg === null) return null;
  let engine: unknown;
  try {
    engine = (JSON.parse(pkg) as { engines?: { node?: unknown } } | null)?.engines?.node;
  } catch {
    return null;
  }
  const major = typeof engine === "string" ? nodeMajor(engine, true) : null;
  return major ? { major, from: "package.json engines" } : null;
}

/**
 * Prints `current=<the worker's node --version>` and, for each installed Node of major `$0` in the known version
 * manager folders whose `node --version` agrees, `found=<its bin folder>` (globs sort ascending: the newest last).
 */
export const NODE_PROBE = [
  'want="$0"',
  'echo "current=$(node --version 2>/dev/null)"',
  'for d in "${NVM_DIR:-$HOME/.nvm}"/versions/node/v"$want".*/bin \\',
  '  "${FNM_DIR:-$HOME/.local/share/fnm}"/node-versions/v"$want".*/installation/bin \\',
  '  "$HOME/Library/Application Support/fnm/node-versions"/v"$want".*/installation/bin \\',
  '  "$HOME"/.volta/tools/image/node/"$want".*/bin \\',
  '  /opt/homebrew/opt/node@"$want"/bin /usr/local/opt/node@"$want"/bin; do',
  '  [ -x "$d/node" ] || continue',
  '  case "$("$d/node" --version 2>/dev/null)" in v"$want".*) echo "found=$d" ;; esac',
  "done",
].join("\n");

/**
 * The Node of major `want.major` to run the checks on: the worker's own when it matches, else the newest matching
 * install the probe found. None: a checks_env failure naming the version needed and the one found, if any.
 */
export async function chooseNode(w: Worker, handle: SandboxHandle, want: NodeWant): Promise<NodeChoice> {
  const r = await w.d.sandbox.exec(handle, ["sh", "-c", NODE_PROBE, want.major], { env: { ...w.d.toolEnv } });
  const lines = r.stdout.split("\n");
  const current = lines.find((l) => l.startsWith("current="))?.slice("current=".length).trim() ?? "";
  if (nodeMajor(current, false) === want.major) return { bin: null, version: current };
  const found = lines.filter((l) => l.startsWith("found=")).map((l) => l.slice("found=".length)).at(-1);
  if (found) return { bin: found, version: `v${want.major}` };
  throw new RunFailure(
    CHECKS_ENV,
    `the checks need Node ${want.major} (from ${want.from}), which is not installed; found ${current ? `Node ${current}` : "no Node"}. Install Node ${want.major} (e.g. nvm install ${want.major}) on this worker.`,
  );
}

/** Puts the chosen Node's folder first on PATH for one command, keeping the command's own argv after it. */
const ON_PATH = 'PATH="$0:$PATH"; export PATH; exec "$@"';

export function onNode(node: NodeChoice, cmd: readonly string[]): string[] {
  return node.bin === null ? [...cmd] : ["sh", "-c", ON_PATH, node.bin, ...cmd];
}

/** The command as the project names it, without the wrapper `onNode` adds. */
export function offNode(cmd: readonly string[]): string[] {
  return cmd[0] === "sh" && cmd[1] === "-c" && cmd[2] === ON_PATH ? cmd.slice(4) : [...cmd];
}
