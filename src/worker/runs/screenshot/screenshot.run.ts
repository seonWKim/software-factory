// The screenshot run (design 04-screenshots): queued by the controller after a review passes on a change that touches
// a `repo.ui_check` path. No agent and no push. In a run folder on the item's branch it runs the install step
// (installStep: `repo.install_commands`, else the install command through the run-side install cache) and the dashboard's build, then captures every sidebar page, the item page and
// the transcript page at 390px and 1280px, in light and dark, from the seeded fixture store (never the item's data),
// every command through the run's sandbox, each PNG put in shared storage under `<item id>/<run id>/<page>-<width>-<theme>.png`. A build that fails, a missing
// Chrome or a failed capture is a result: the captures it has and a reason, never a run failure, so the item is not
// held. The controller then queues the screenshot review on what it stored.

import { cachedInstall } from "../../install-cache.js";
import type { Worker } from "../../runner.js";
import { DEFAULT_TIMEOUTS, type RunCall, type RunKindDescriptor, defineRunKind } from "../../run-kind.js";
import { chromeBrowser } from "../../../shared/chrome-browser.js";
import { type RunExec, type ScreenshotBrowser, type ScreenshotOutcome, captureAll } from "../../../shared/screenshots.js";

/** The dashboard's build: the fixture serves the checkout's dist/ and web/dist/. */
export const BUILD_COMMAND = ["npm", "run", "--silent", "build"];

async function screenshot(w: Worker, c: RunCall, browser: ScreenshotBrowser): Promise<Record<string, unknown>> {
  const { run, item, signal } = c;
  const handle = c.handle!;
  const review_run_id = typeof run.input?.review_run_id === "string" ? run.input.review_run_id : null;
  const outcome = await c.step("capture", async (): Promise<ScreenshotOutcome> => {
    const runOn = (commands: NonNullable<Worker["cfg"]["repo"]["check_commands"]>) => w.runCheckList(run, handle, signal, { commands });
    const install = await w.checkTools.installStep(w.cfg.repo, runOn, (go) => cachedInstall(w, handle, go));
    if (install?.failed) return { captures: [], reason: `the install command failed (${install.failed.how})` };
    const build = await runOn([BUILD_COMMAND]);
    if (build.failed) return { captures: [], reason: `the build failed (${build.failed.how})` };
    const exec: RunExec = (cmd, o) => w.d.sandbox.exec(handle, cmd, o);
    return captureAll(browser, w.d.storage, { item_id: item.id, run_id: run.id, exec, signal });
  });
  return { captures: outcome.captures, reason: outcome.reason, review_run_id };
}

/** The screenshot run kind on `browser`; the default export uses Chrome, a test hands a fake. */
export function screenshotRun(browser: ScreenshotBrowser): RunKindDescriptor {
  return defineRunKind({
    name: "screenshot",
    folder: true,
    timeouts: DEFAULT_TIMEOUTS,
    execute: (w, c) => screenshot(w, c, browser),
  });
}

export default screenshotRun(chromeBrowser());
