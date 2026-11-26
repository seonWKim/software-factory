import { join } from "node:path";
import { Plugins, buildUiParts, uiPort } from "../../../compose.js";
import { FORGE_BUDGET_PLUGIN } from "../../../impl/github/github-client.js";
import { SUPERVISOR_STATUS_FILE } from "../../../interfaces/updater.js";
import { createPlugin, selectedSources } from "../../../plugins.js";
import { doctorChecks } from "../../../setup.js";
import { SUPERVISED_ENV } from "../../../supervisor.js";
import { modelStallChecks, projectKeyChecks, readFactoryStatus } from "../../../ui/factory-status.js";
import { HealthMonitor, syncChecks } from "../../../ui/health.js";
import { startUi } from "../../../ui/server.js";
import { LastChecks, checkoutRevision, olderThanFactory, serverRevision, watchRevision } from "../../../ui/system-actions.js";
import { type SkillEvalRunFn, type SkillEvalTryFn, defineCommand } from "../../command.js";
import type { SkillEvalAuthoring } from "../../../runtime/index.js";
import { stopOnSignals } from "../../support.js";

export default defineCommand({
  names: ["ui"],
  usage: `  ui           status page at http://127.0.0.1:<ui.port>/ (default 4310); no controller or worker. Under the
               git-worktree updater, dev runs it too and restarts it on each new revision`,
  async run(_args, ctx) {
    const loaded = await ctx.load();
    // An ID, never a display name: the same local identity as the CLI's (issue #318), so the owner check sees one
    // user for the UI and the terminal.
    const identity = await ctx.identity();
    const parts = await buildUiParts(loaded, { identity });
    // The last health run, kept for Needs you: the token's days without a GitHub call per poll.
    const lastChecks = new LastChecks();
    const revision = await serverRevision(loaded.codeRoot);
    const checkout = await checkoutRevision(loaded.codeRoot);
    const factoryStatus = () => readFactoryStatus(join(loaded.stateDir, SUPERVISOR_STATUS_FILE), loaded.config.workers);
    // A page started by hand (not the supervisor's child, which it swaps) never serves code older than the
    // factory runs (design 08 Self-update): it refuses to start, and stops once the factory moves past it.
    const supervised = process.env[SUPERVISED_ENV] === "1" && process.send !== undefined;
    const older = async () => (supervised ? null : olderThanFactory(loaded.codeRoot, checkout, (await factoryStatus())?.rev ?? null));
    const refused = await older();
    if (refused !== null) {
      console.log(refused);
      await parts.close();
      return 1;
    }
    const uiEvals = (authoring: SkillEvalAuthoring & { importCases: NonNullable<SkillEvalAuthoring["importCases"]> }, tryCase: SkillEvalTryFn) => ({
      authoring,
      tryCase: (store: Parameters<SkillEvalTryFn>[0], r: Parameters<SkillEvalTryFn>[2]) => tryCase(store, loaded, r),
      // Run now (POST /api/v1/evals/<skill>/runs): `eval run` with the same checks, as the page's factory user.
      // Draft starter cases (starter.draft and starter.accept): the Model plugin and SKILL.md reader buildUiParts built.
      starter: parts.starter,
      ...(ctx.runSkillEval && { run: (store: Parameters<SkillEvalRunFn>[0], r: Parameters<SkillEvalRunFn>[2]) => ctx.runSkillEval!(store, loaded, r) }),
      source: {
        configured: loaded.plugins.eval_source, registered: Object.keys(loaded.registry.eval_source.plugins), settings: parts.tacit.settings,
        open: (name: string) => createPlugin(loaded.registry, "eval_source", name, new Plugins(loaded).base),
      },
    });
    const ui = await startUi(
      {
        store: parts.store,
        scanner: parts.scanner,
        clock: parts.clock,
        lease_ms: loaded.config.lease_ms,
        plugins: { issues: selectedSources(loaded.plugins).includes("github-issues") ? "github" : null },
        // The same checks as `factory doctor` (without --llm: opening the page makes no model call).
        // A stall pause (design §5 Restarts) shows first, as a failing row: `agents paused: model not answering since …`.
        // A first start waiting for GitHub to resolve the project key (design 2026-11-07) shows as a warn.
        health: new HealthMonitor(
          lastChecks.wrap(async () => [
            ...(await modelStallChecks(parts.store)),
            ...(await projectKeyChecks(parts.store, loaded.config.repo)),
            // The GitHub sync line: the shared budget and the sync lease holder, read from the store (design 05-coordination).
            ...(loaded.config.local_only === true ? [] : await syncChecks(parts.store, loaded.config.repo, FORGE_BUDGET_PLUGIN, parts.clock.now())),
            ...(await doctorChecks(loaded)),
          ]),
          parts.clock,
        ),
        lastChecks,
        // The revision this server's build was made from (the stamp in dist/): the app shows a banner when its own differs.
        revision,
        // What the supervisor (`factory dev`) is doing: the banner explains drains and when settings apply.
        factoryStatus,
        // The Settings page (GET and POST /api/v1/settings): the same checks as `factory settings`, no forge call.
        settings: parts.settings,
        // The configured shared storage, read only by the transcript view (byte ranges, design §9).
        storage: await createPlugin(loaded.registry, "storage", loaded.plugins.storage, new Plugins(loaded).base),
        // Item commands (POST /api/v1/items/:id/commands): recorded as ui.user_id, or this machine's CLI identity, for the controller to apply.
        commands: parts.commands,
        // Names where the pages show user ids (identity_profiles, read by id; ids stay what is stored).
        displayNames: parts.displayNames,
        // "Resume now" on the Floor and Health pages (POST /api/v1/pauses/resume): owner check, then endClaimPause.
        pauses: parts.pauses,
        // The Rules page (GET /api/v1/rules, POST /api/v1/rules/verdict): the tacit ledger's list and verdict, owner only;
        // a live holder, switched by the `integrations` setting before each Rules request.
        tacit: parts.tacit,
        // A skill draft's Promote on the Rules page (POST /api/v1/rules/skill-verdict): the skill wiring, absent without capabilities.skill_folders.
        skillImprove: parts.skillImprove,
        // Migrate now, Start and Restart now (POST /api/v1/migrate and /api/v1/supervisor): the supervisor's request file,
        // behind the resume route's owner check.
        migrate: parts.migrate,
        // POST /api/v1/evals/write: the CLI's suite and case rules, `case try`, and import from the eval source the
        // `integrations` entry names, else plugins.eval_source, built for each call through the registry; and
        // POST /api/v1/evals/<skill>/runs: Run now, `eval run` through runSkillEval.
        ...(ctx.authoring?.importCases && ctx.trySkillEvalCase && { evals: uiEvals({ ...ctx.authoring, importCases: ctx.authoring.importCases }, ctx.trySkillEvalCase) }),
        ...(parts.changes && { changes: parts.changes }),
      },
      uiPort(loaded.file.ui),
    );
    const { actor, source } = parts.commands;
    const actsAs = actor === null ? "nobody: set ui.user_id" : `${actor} from ${source}`;
    console.log(`status page: http://${ui.address}:${ui.port}/ (writes: Settings and Resume now as ${identity.user}, and item commands as ${actsAs}; Ctrl-C to stop)`);
    // The supervisor's ui child (design: Self-update) also stops when the supervisor is gone, never as an orphan.
    const orphan = new AbortController();
    if (supervised) process.once("disconnect", () => orphan.abort());
    // The hand-started page rereads the supervisor's status file (a local read) every 30 s.
    const stale = watchRevision(older);
    const signal = AbortSignal.any([stopOnSignals(), orphan.signal, stale.signal]);
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    stale.stop();
    const staleText = stale.text();
    if (staleText !== null) console.log(staleText);
    await ui.close();
    await parts.close();
    return staleText === null ? 0 : 1;
  },
});
