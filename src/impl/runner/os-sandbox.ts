// The host's OS sandbox as the claude-code runner uses it (design 05-sandbox.md, RFC 0024 WP2 step A): the live
// checkout's read denial with its carve-outs, and the probe that `factory doctor` and the `mode` setting ask
// whether reads, writes and network are OS-enforced on this host. The probe calls no model.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

/** doctor's three sandbox lines, in order. */
export const SANDBOX_LINES = ["reads", "writes", "network"] as const;
export type SandboxLine = (typeof SANDBOX_LINES)[number];
export type SandboxEnforcement = Record<SandboxLine, { enforced: boolean; why: string }>;

/** The live checkout's read denial for one agent step (buildHarnessSettings). */
export interface CheckoutDenial {
  /** The checkout's real path: in `sandbox.filesystem.denyRead`. */
  checkout: string;
  /** What a run still reads inside it (its run folder, its home, the harness config dir, `.git/objects`): `allowRead`. */
  carve_outs: string[];
  /**
   * Every other entry of the checkout on the way to a kept folder, for `Read(...)` deny rules: the native file tools
   * do not go through the OS sandbox, and a permission deny beats any allow, so the checkout itself cannot be one.
   */
  read_denies: string[];
}

const inside = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);
const real = (p: string) => realpath(p).catch(() => null);

/**
 * The denial for `checkout`. `own`: the run's folders the OS denial carves out (run folder, home, harness config
 * dir); the checkout's `.git/objects` is added, since a run's clone borrows its objects through an alternates link.
 * `tool_keep`: folders the Read rules leave whole (the runner's homes folder, one entry per past run). Real paths
 * only (the OS sandbox matches those); a folder that does not exist is skipped. No checkout folder: null.
 */
export async function checkoutDenial(checkout: string, own: readonly string[], tool_keep: readonly string[] = []): Promise<CheckoutDenial | null> {
  const root = await real(checkout);
  if (root === null) return null;
  const reals = async (ps: readonly string[]) => (await Promise.all(ps.map(real))).filter((p): p is string => p !== null && inside(p, root) && p !== root);
  const carve_outs = await reals([...own, join(checkout, ".git", "objects")]);
  return { checkout: root, carve_outs, read_denies: await others(root, [...carve_outs, ...(await reals(tool_keep))]) };
}

/** Entries of `dir` that hold no kept folder, and inside each entry on the way to one, the same again. */
async function others(dir: string, keep: readonly string[]): Promise<string[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const out: string[] = [];
  for (const name of names.sort()) {
    const p = join(dir, name);
    const under = keep.filter((k) => inside(k, p));
    if (under.length === 0) out.push(p);
    else if (!under.includes(p)) out.push(...(await others(p, under)));
  }
  return out;
}

/** How the probe runs a command; tests pass a fake. */
export type ProbeExec = (cmd: readonly string[]) => Promise<{ exit_code: number | null; stdout: string } | null>;

/** A probe command with the host's PATH and HOME only; a command that cannot start is null. */
const exec: ProbeExec = (cmd) =>
  new Promise((resolve) => {
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "", LANG: "C.UTF-8" };
    execFile(cmd[0]!, cmd.slice(1), { cwd: tmpdir(), env, timeout: 15_000, encoding: "utf8" }, (err, stdout) => {
      const code = err ? (typeof err.code === "number" ? err.code : null) : 0;
      resolve(err && code === null && !stdout ? null : { exit_code: code, stdout });
    });
  });

const all = (enforced: boolean, why: string): SandboxEnforcement => ({ reads: { enforced, why }, writes: { enforced, why }, network: { enforced, why } });

/** What runs inside the OS wrapper: reads an allowed file (the control), then tries a denied read, write and connect. */
const PROBE_JS = `const fs=require("fs"),net=require("net");const [ok,deny,wdeny,port]=process.argv.slice(1);
const t=(f)=>{try{f();return true}catch{return false}};const r={control:t(()=>fs.readFileSync(ok)),read:t(()=>fs.readFileSync(deny)),write:t(()=>fs.writeFileSync(wdeny,"x"))};
let done=false;const s=net.connect({port:Number(port),host:"127.0.0.1",timeout:3000});
const end=(c)=>{if(done)return;done=true;s.destroy();console.log(JSON.stringify({...r,connect:c}))};
s.on("connect",()=>end(true));s.on("error",()=>end(false));s.on("timeout",()=>end(false));`;

const quote = (p: string) => `"${p.replace(/[\\"]/g, (c) => `\\${c}`)}"`;

/** The wrapper argv per platform: Seatbelt on macOS, bubblewrap on Linux (what Claude Code's sandbox uses). Null: none. */
export function wrapperArgv(platform: NodeJS.Platform, d: { denyRead: string; denyWrite: string; allow: string }): string[] | null {
  if (platform === "darwin") {
    const profile = `(version 1)(allow default)(deny file-read* (subpath ${quote(d.denyRead)}))(deny file-write* (subpath ${quote(d.denyWrite)}))(deny network-outbound)`;
    return ["/usr/bin/sandbox-exec", "-p", profile];
  }
  if (platform === "linux") return ["bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", d.denyRead, "--bind", d.allow, d.allow, "--unshare-net", "--die-with-parent"];
  return null;
}

/**
 * Whether reads, writes and network are OS-enforced for agent runs on this host (decision 3: a probe, no model
 * call). `runners`: the selected chain (`plugins.runner`); only claude-code has an OS sandbox, so a chain naming another
 * runner is not enforced. For claude-code, Claude Code must report its sandbox on and
 * supported with the strict filesystem policy, and the host wrapper must refuse a denied read, write and connect
 * while the same process reads an allowed file. Anything else, a probe that cannot run included, is not enforced.
 */
export async function probeOsSandbox(o: { runners: readonly string[]; claudeBin?: string; platform?: NodeJS.Platform; exec?: ProbeExec }): Promise<SandboxEnforcement> {
  const other = o.runners.find((r) => r !== "claude-code");
  if (other !== undefined || o.runners.length === 0) return all(false, `the ${other ?? "selected"} runner has no OS sandbox`);
  const run = o.exec ?? exec;
  const settings = JSON.stringify({ sandbox: { enabled: true, allowUnsandboxedCommands: false } });
  const status = await run([o.claudeBin ?? "claude", "--setting-sources", "project", "--settings", settings, "sandbox", "status"]);
  let s: { enabled?: unknown; supported?: unknown; unavailableReason?: unknown; filesystemPolicy?: unknown } = {};
  try {
    s = JSON.parse(status?.stdout.trim().split("\n").pop() ?? "") as typeof s;
  } catch {
    return all(false, "`claude sandbox status` gave no answer (is Claude Code installed?)");
  }
  if (s.enabled !== true || s.supported !== true || (s.unavailableReason ?? null) !== null) {
    return all(false, `Claude Code's sandbox is off on this host${typeof s.unavailableReason === "string" ? `: ${s.unavailableReason}` : ""}`);
  }
  const fsPolicy = s.filesystemPolicy === "strict" ? null : `Claude Code's filesystem policy is ${String(s.filesystemPolicy)}, not strict`;
  const probed = await hostProbe(o.platform ?? process.platform, run);
  if (typeof probed === "string") return all(false, probed);
  const line = (enforced: boolean, what: string, extra: string | null): { enforced: boolean; why: string } =>
    extra !== null ? { enforced: false, why: extra } : enforced ? { enforced, why: `a probe ${what} was refused` } : { enforced, why: `a probe ${what} went through` };
  return { reads: line(!probed.read, "read of a denied file", fsPolicy), writes: line(!probed.write, "write to a denied folder", fsPolicy), network: line(!probed.connect, "connect", null) };
}

/** Runs PROBE_JS under the host wrapper in a temp folder; the result, or why it could not run. */
async function hostProbe(platform: NodeJS.Platform, run: ProbeExec): Promise<{ read: boolean; write: boolean; connect: boolean } | string> {
  const dir = await real(await mkdtemp(join(tmpdir(), "sf-sandbox-probe-")));
  if (dir === null) return "the probe's temp folder could not be made";
  const server = createServer((c) => c.destroy());
  try {
    const [allow, denyRead, denyWrite] = ["allow", "deny-read", "deny-write"].map((n) => join(dir, n)) as [string, string, string];
    for (const d of [allow, denyRead, denyWrite]) await mkdir(d);
    await writeFile(join(allow, "ok"), "ok");
    await writeFile(join(denyRead, "secret"), "probe");
    const argv = wrapperArgv(platform, { denyRead, denyWrite, allow });
    if (argv === null) return `no OS sandbox the factory knows on ${platform}`;
    const port = await new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
    const r = await run([...argv, process.execPath, "-e", PROBE_JS, join(allow, "ok"), join(denyRead, "secret"), join(denyWrite, "x"), String(port)]);
    let out: { control?: boolean; read?: boolean; write?: boolean; connect?: boolean } = {};
    try {
      out = JSON.parse(r?.stdout.trim().split("\n").pop() ?? "") as typeof out;
    } catch {
      /* handled below */
    }
    if (out.control !== true) return `the OS sandbox (${argv[0]}) could not run a probe command on this host`;
    return { read: out.read !== false, write: out.write !== false, connect: out.connect !== false };
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
}
