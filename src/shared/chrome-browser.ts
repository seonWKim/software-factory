// The Chrome ScreenshotBrowser (design 04-screenshots). It runs the checkout's own `scripts/responsive/capture.mjs` as
// a child process in the checkout: that script seeds the throwaway fixture store (scripts/responsive/fixture.mjs, as
// check:responsive does), serves it with the checkout's built UI server and drives headless Chrome through the
// check's DevTools driver (scripts/responsive/cdp.mjs). The worker never imports the driver: it talks to the script in
// JSON lines over stdin and stdout. The child gets only the env Chrome needs (CAPTURE_ENV): no token, no secret.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { type BrowserSession, CaptureUnavailable, type ScreenshotBrowser, capturePages } from "./screenshots.js";

/** The capture script, relative to the checkout. */
const CAPTURE_SCRIPT = join("scripts", "responsive", "capture.mjs");

/** The env names the capture script may see: where programs, the home folder and temp files are, and Chrome's path. */
export const CAPTURE_ENV = ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "CHROME_PATH", "CI"] as const;

/** `env` cut to CAPTURE_ENV. */
export function captureEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return Object.fromEntries(CAPTURE_ENV.flatMap((k) => (env[k] === undefined ? [] : [[k, env[k]!] as const])));
}

/** One line the script writes. */
interface Reply {
  ready?: { item: string; run: string; pages_ts: string };
  png?: string;
  error?: string;
  unavailable?: boolean;
}

/** The Chrome browser, on the Node that runs this worker. */
export function chromeBrowser(node: string = process.execPath, env: Readonly<Record<string, string | undefined>> = process.env): ScreenshotBrowser {
  return {
    async open(root, signal) {
      if (!existsSync(join(root, CAPTURE_SCRIPT))) throw new CaptureUnavailable(`the checkout has no ${CAPTURE_SCRIPT}`);
      const child = spawn(node, ["--disable-warning=ExperimentalWarning", CAPTURE_SCRIPT], { cwd: root, env: captureEnv(env), stdio: ["pipe", "pipe", "pipe"], signal });
      let stderr = "";
      child.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2_000)));
      child.on("error", () => undefined); // an abort or a spawn failure: the line reader ends, and `next` says so
      const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
      const next = async (): Promise<Reply> => {
        const r = await lines.next();
        if (r.done) throw new Error(`the capture script exited${stderr.trim() ? `: ${stderr.trim().split("\n").at(-1)}` : ""}`);
        return JSON.parse(r.value) as Reply;
      };
      const send = (msg: unknown) => child.stdin.write(`${JSON.stringify(msg)}\n`);
      const close = async () => {
        child.stdin.end();
        if (child.exitCode === null && child.signalCode === null) await new Promise((r) => child.once("close", r));
      };
      const first = await next().catch(async (e: unknown) => {
        await close();
        throw e;
      });
      if (!first.ready) {
        await close();
        throw first.unavailable ? new CaptureUnavailable(first.error ?? "the browser is not available") : new Error(first.error ?? "the capture script did not start");
      }
      const session: BrowserSession = {
        pages: capturePages(first.ready.pages_ts, first.ready),
        async shoot(page, at) {
          send({ shoot: { path: page.path, ...at } });
          const r = await next();
          if (typeof r.png !== "string") throw new Error(r.error ?? "no image");
          return Buffer.from(r.png, "base64");
        },
        close,
      };
      return session;
    },
  };
}
