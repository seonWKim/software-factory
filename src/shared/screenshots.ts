// Screenshots of changed dashboard pages before merge (design 04-screenshots): the capture set, the storage keys, the
// trigger rule and the outcome shapes the worker, the controller, the item API and the item page share. Pure, apart
// from `captureAll`, which drives a ScreenshotBrowser and a storage it is handed.

/** The fixed widths (phone, desktop) and the height each is shown at: no setting changes them. */
export const SCREENSHOT_SIZES = [{ width: 390, height: 844 }, { width: 1280, height: 800 }] as const;
export const SCREENSHOT_THEMES = ["light", "dark"] as const;
export type ScreenshotTheme = (typeof SCREENSHOT_THEMES)[number];

/** One dashboard page to capture: its name in the key and its path under the app (`/app/<path>`). */
export interface ScreenshotPage {
  readonly name: string;
  readonly path: string;
}

/** One stored screenshot: its page, width and theme, and its shared-storage key. */
export interface Capture {
  readonly page: string;
  readonly width: number;
  readonly theme: ScreenshotTheme;
  readonly key: string;
}

/** A screenshot run's outcome: the captures it stored, and why it stopped short (null when every page was captured). */
export interface ScreenshotOutcome {
  readonly captures: readonly Capture[];
  readonly reason: string | null;
}

/** A finding of the screenshot review, in the review's own shape. */
interface ScreenshotFinding {
  readonly kind: string;
  readonly text: string;
}

/** What a screenshot review run stores (outcome data `screenshot_review`): never a verdict the controller routes on. */
export interface ScreenshotReview {
  readonly findings: readonly ScreenshotFinding[];
  readonly unverified: readonly string[];
  readonly summary: string;
}

/** The run input that makes a review run the screenshot review. */
export const SCREENSHOT_REVIEW = "screenshot_review";

/** The storage key of one screenshot: `<item id>/<run id>/<page>-<width>-<theme>.png`. */
export const screenshotKey = (item: string, run: string, page: string, width: number, theme: ScreenshotTheme): string =>
  `${item}/${run}/${page}-${width}-${theme}.png`;

/** The screenshot run's key: one per item and passing review run. */
export const screenshotRunKey = (item: string, review_run: string): string => `${item}:screenshot:${review_run}`;

/** The screenshot review's key: one per item and screenshot run. */
export const screenshotReviewKey = (item: string, screenshot_run: string): string => `${item}:review:screenshots:${screenshot_run}`;

/** The unverified line of a capture that did not happen. */
export const notCapturedLine = (reason: string): string => `screenshots not captured: ${reason}`;

/** Whether a change's files touch one of the UI paths (`repo.ui_check.paths`). No files: false. */
export function touchesUi(files: readonly string[] | null | undefined, paths: readonly string[]): boolean {
  return (files ?? []).some((f) => paths.some((p) => f.startsWith(p)));
}

/** The placeholders in a page path the capture script fills with its fixture's item and run IDs. */
const FIXTURE_ITEM = ":item";
const FIXTURE_RUN = ":run";

/**
 * The pages a screenshot run captures: every sidebar page `web/src/pages.ts` lists (as check:responsive reads it), then
 * the fixture's item page and its run's transcript page (their IDs as FIXTURE_ITEM and FIXTURE_RUN).
 */
export function capturePages(pagesTs: string): ScreenshotPage[] {
  const sidebar = [...pagesTs.matchAll(/\{\s*path:\s*"([^"]*)",\s*label:\s*"([^"]+)"/g)].map((m) => ({ name: m[1] || "floor", path: m[1]! }));
  const item = `items/${FIXTURE_ITEM}`;
  return [...sidebar, { name: "item", path: item }, { name: "transcript", path: `${item}/runs/${FIXTURE_RUN}` }];
}

/** One shot: a page at a size and theme. */
interface Shot {
  readonly page: ScreenshotPage;
  readonly width: number;
  readonly height: number;
  readonly theme: ScreenshotTheme;
}

/** Every page at each width in each theme, in capture order. */
export const shotsOf = (pages: readonly ScreenshotPage[]): Shot[] =>
  pages.flatMap((page) => SCREENSHOT_SIZES.flatMap((size) => SCREENSHOT_THEMES.map((theme) => ({ page, ...size, theme }))));

const THEMES: readonly string[] = SCREENSHOT_THEMES;
const isCapture = (c: unknown): c is Capture => {
  const x = c as Partial<Capture> | null;
  return typeof x === "object" && x !== null && typeof x.page === "string" && typeof x.width === "number" && THEMES.includes(x.theme as string) && typeof x.key === "string";
};

/** A stored screenshot outcome (a run's data, or a review run's input), or null when it has neither captures nor a reason. */
export function parseScreenshotOutcome(v: unknown): ScreenshotOutcome | null {
  const o = v as { captures?: unknown; reason?: unknown } | null;
  if (typeof o !== "object" || o === null || !Array.isArray(o.captures) || !o.captures.every(isCapture)) return null;
  const reason = typeof o.reason === "string" && o.reason !== "" ? o.reason : null;
  return o.captures.length > 0 || reason !== null ? { captures: o.captures.map(({ page, width, theme, key }) => ({ page, width, theme, key })), reason } : null;
}

/** A stored screenshot review (outcome data `screenshot_review`), or null. */
export function parseScreenshotReview(v: unknown): ScreenshotReview | null {
  const r = v as { findings?: unknown; unverified?: unknown; summary?: unknown } | null;
  if (typeof r !== "object" || r === null || !Array.isArray(r.findings) || !Array.isArray(r.unverified)) return null;
  const findings = r.findings.filter((f): f is ScreenshotFinding => typeof f?.kind === "string" && typeof f?.text === "string");
  const unverified = r.unverified.filter((u): u is string => typeof u === "string");
  return { findings, unverified, summary: typeof r.summary === "string" ? r.summary : "" };
}

/** Raised by a ScreenshotBrowser that cannot start (no Chrome, no fixture, no build): its message is the reason. */
export class CaptureUnavailable extends Error {}

/** A command in the run folder, through the run's sandbox (the worker binds `Sandbox.exec` to its handle). */
export type RunExec = (
  cmd: readonly string[],
  o: { env: Readonly<Record<string, string>>; stdin?: string; signal?: AbortSignal },
) => Promise<{ exit_code: number | null; stdout: string; stderr: string }>;

/** A browser on the seeded fixture dashboard, open until `close`. */
export interface BrowserSession {
  /** The pages it can show (capturePages on the checkout's sidebar). */
  readonly pages: readonly ScreenshotPage[];
  /** One PNG of `page` at the size and theme. */
  shoot(page: ScreenshotPage, at: { width: number; height: number; theme: ScreenshotTheme }): Promise<Uint8Array>;
  close(): Promise<void>;
}

/** Starts the seeded fixture dashboard built in the run folder `exec` runs in, and a browser on it. Chrome in production, a fake in tests. */
export interface ScreenshotBrowser {
  open(exec: RunExec, signal: AbortSignal): Promise<BrowserSession>;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 300);

/**
 * Every shot (shotsOf), each PNG put in `storage` under its key as soon as the browser hands it over. A browser that
 * cannot open, or a capture that fails, ends the run with the captures it has and a reason: never a throw, unless the
 * run was aborted.
 */
export async function captureAll(
  browser: ScreenshotBrowser,
  storage: { put(key: string, data: Uint8Array): Promise<void> },
  o: { item_id: string; run_id: string; exec: RunExec; signal: AbortSignal },
): Promise<ScreenshotOutcome> {
  let session: BrowserSession;
  try {
    session = await browser.open(o.exec, o.signal);
  } catch (e) {
    if (o.signal.aborted) throw e;
    return { captures: [], reason: e instanceof CaptureUnavailable ? messageOf(e) : `the browser did not start: ${messageOf(e)}` };
  }
  const captures: Capture[] = [];
  try {
    for (const { page, theme, ...size } of shotsOf(session.pages)) {
      try {
        const key = screenshotKey(o.item_id, o.run_id, page.name, size.width, theme);
        await storage.put(key, await session.shoot(page, { ...size, theme }));
        captures.push({ page: page.name, width: size.width, theme, key });
      } catch (e) {
        if (o.signal.aborted) throw e;
        return { captures, reason: `the capture of ${page.name} at ${size.width}px, ${theme} failed: ${messageOf(e)}` };
      }
    }
  } finally {
    await session.close().catch(() => undefined);
  }
  return { captures, reason: captures.length === 0 ? "the checkout lists no page to capture" : null };
}
