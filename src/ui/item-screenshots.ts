// The item page's Changes tab (design 04-screenshots, 09-dashboard-item): the item's newest screenshot run, with its
// captures by page, width and theme or the reason it took none, and the newest screenshot review's findings and
// unverified lines. Every text passes the Withholder, as the other item fields do. Served beside api.ts, which may not
// grow (file budget); GET /api/v1/screenshot returns one stored image of the item's screenshot run.

import type { Run, WorkItemId } from "../core/types.js";
import { SCREENSHOT_REVIEW, type ScreenshotTheme, parseScreenshotOutcome, parseScreenshotReview, screenshotKey } from "../shared/screenshots.js";
import { type ApiResult, apiError } from "./api.js";
import type { ServerDeps } from "./server.js";

type Text = (value: string | null, channel?: "run_outcome") => Promise<string | null>;

/** The image route's path. */
export const SCREENSHOT_PATH = "/api/v1/screenshot";

/** The newest run that `pick` takes, or undefined. */
const newest = (runs: readonly Run[], pick: (r: Run) => boolean): Run | undefined => [...runs].reverse().find(pick);
const isScreenshotReview = (r: Run): boolean => r.kind === "review" && r.input?.[SCREENSHOT_REVIEW] === true;

/** `screenshots` (null: no screenshot run) and `screenshot_review` (null: none queued) for the item API. */
export async function screenshotFields(runs: readonly Run[], text: Text) {
  const run = newest(runs, (r) => r.kind === "screenshot");
  const review = newest(runs, isScreenshotReview);
  const done = run?.outcome?.status === "succeeded" ? parseScreenshotOutcome(run.outcome.data) : null;
  const failed = run?.outcome?.status === "failed" ? `the screenshot run failed (${run.outcome.error_code || "unknown"})` : null;
  const captures = [];
  for (const c of done?.captures ?? []) captures.push({ page: (await text(c.page))!, width: c.width, theme: c.theme, key: (await text(c.key))! });
  const r = review?.outcome?.status === "succeeded" ? parseScreenshotReview(review.outcome.data[SCREENSHOT_REVIEW]) : null;
  const all = async (xs: readonly string[]) => Promise.all(xs.map(async (x) => (await text(x, "run_outcome"))!));
  return {
    screenshots: run ? { run_id: run.id, status: run.status, captures, reason: await text(done?.reason ?? failed, "run_outcome") } : null,
    screenshot_review: review ? {
      run_id: review.id,
      status: review.status,
      findings: await Promise.all((r?.findings ?? []).map(async (f) => ({ kind: f.kind, text: (await text(f.text, "run_outcome"))! }))),
      unverified: await all(r?.unverified ?? []),
      summary: await text(r?.summary || null, "run_outcome"),
    } : null,
  };
}

/**
 * GET /api/v1/screenshot?item=&run=&page=&width=&theme=: one image of the item's screenshot run, as a PNG data URL. Only
 * a capture that run's outcome lists is read, so no other storage key can be named. 404 for anything else.
 */
export async function readScreenshot(d: ServerDeps, q: URLSearchParams): Promise<ApiResult> {
  const item = q.get("item") ?? "", runId = q.get("run") ?? "", page = q.get("page") ?? "", width = Number(q.get("width")), theme = q.get("theme") ?? "";
  const run = (await d.store.listRuns(item as WorkItemId).catch((): Run[] => [])).find((r) => r.id === runId && r.kind === "screenshot");
  const shots = run?.outcome?.status === "succeeded" ? parseScreenshotOutcome(run.outcome.data) : null;
  const key = screenshotKey(item, runId, page, width, theme as ScreenshotTheme);
  if (!d.storage || !shots?.captures.some((c) => c.key === key)) return apiError(404, "No such screenshot.");
  const bytes = await d.storage.get(key).catch(() => null);
  if (!bytes) return apiError(404, "The screenshot is no longer stored.");
  return { status: 200, value: { data_url: `data:image/png;base64,${Buffer.from(bytes).toString("base64")}` } };
}
