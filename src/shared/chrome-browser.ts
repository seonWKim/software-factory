// The Chrome ScreenshotBrowser (design 04-screenshots). Everything runs through the run's sandbox (`RunExec`, which the
// worker binds to `Sandbox.exec` on the run folder): never a host process. It reads the checkout's sidebar
// (`web/src/pages.ts`), then runs the checkout's own `scripts/responsive/capture.mjs` once with the fixed list of shots
// on stdin. That script seeds the throwaway fixture store (scripts/responsive/fixture.mjs, as check:responsive does),
// serves it with the checkout's built UI server and drives headless Chrome through the check's DevTools driver
// (scripts/responsive/cdp.mjs); it answers on stdout, one JSON line per shot, in order. The worker never imports the
// driver. The script gets only the env Chrome needs (CAPTURE_ENV): no token, no secret.

import { type BrowserSession, CaptureUnavailable, type RunExec, type ScreenshotBrowser, capturePages, shotsOf } from "./screenshots.js";

/** The capture script and the sidebar list, relative to the run folder. */
const CAPTURE_SCRIPT = "scripts/responsive/capture.mjs";
const PAGES_TS = "web/src/pages.ts";

/** The env names the capture script may see: where programs, the home folder and temp files are, and Chrome's path. */
export const CAPTURE_ENV = ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "CHROME_PATH", "CI"] as const;

/** `env` cut to CAPTURE_ENV. */
export function captureEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return Object.fromEntries(CAPTURE_ENV.flatMap((k) => (env[k] === undefined ? [] : [[k, env[k]!] as const])));
}

/** One line the script writes. */
interface Reply {
  ready?: boolean;
  png?: string;
  error?: string;
  unavailable?: boolean;
}

const parse = (line: string): Reply => {
  try {
    return JSON.parse(line) as Reply;
  } catch {
    return { error: `the capture script wrote "${line.slice(0, 80)}"` };
  }
};

/** The Chrome browser, with the worker's env cut to CAPTURE_ENV. */
export function chromeBrowser(env: Readonly<Record<string, string | undefined>> = process.env): ScreenshotBrowser {
  return {
    async open(exec: RunExec, signal) {
      const cmdEnv = captureEnv(env);
      if ((await exec(["test", "-f", CAPTURE_SCRIPT], { env: cmdEnv, signal })).exit_code !== 0) throw new CaptureUnavailable(`the checkout has no ${CAPTURE_SCRIPT}`);
      const pagesTs = await exec(["cat", PAGES_TS], { env: cmdEnv, signal });
      if (pagesTs.exit_code !== 0) throw new CaptureUnavailable(`the checkout has no ${PAGES_TS}`);
      const pages = capturePages(pagesTs.stdout);
      const shots = shotsOf(pages);
      const stdin = shots.map((s) => `${JSON.stringify({ shoot: { path: s.page.path, width: s.width, height: s.height, theme: s.theme } })}\n`).join("");
      const r = await exec(["node", "--disable-warning=ExperimentalWarning", CAPTURE_SCRIPT], { env: cmdEnv, stdin, signal });
      const [first, ...replies] = r.stdout.split("\n").filter((l) => l.trim() !== "").map(parse);
      const exited = `the capture script exited${r.stderr.trim() ? `: ${r.stderr.trim().split("\n").at(-1)}` : ""}`;
      if (!first?.ready) {
        throw first?.unavailable ? new CaptureUnavailable(first.error ?? "the browser is not available") : new Error(first?.error ?? exited);
      }
      const session: BrowserSession = {
        pages,
        async shoot(page, at) {
          const reply = replies[shots.findIndex((s) => s.page.path === page.path && s.width === at.width && s.theme === at.theme)];
          if (!reply) throw new Error(exited);
          if (typeof reply.png !== "string") throw new Error(reply.error ?? "no image");
          return Buffer.from(reply.png, "base64");
        },
        async close() {},
      };
      return session;
    },
  };
}
