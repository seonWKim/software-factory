import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Plugins, approveMergeCheck, buildStatsStore, localProject, resolveProject, settingsBase } from "../../../compose.js";
import { cliUserConfig } from "../../../core/config.js";
import { cliIdentity } from "../../../core/local-cli.js";
import { MODE_USAGE, SETTINGS_TOP_WORDS, SETTINGS_USAGE, parseModeArgs, parseSettingsArgs, runSettings } from "../../../settings-cmd.js";
import { storeProjectResolver } from "../../../ui/settings-api.js";
import { defineCommand } from "../../command.js";
import { cliEnvironment } from "../../support.js";

export default defineCommand({
  names: SETTINGS_TOP_WORDS,
  usage: `  settings list | set <key> <value> | reset <key> | history
               change a settable key while the factory runs (design 2026-11-03): max_attempts, max_loops,
               max_restart, retry_base_ms, retry_max_ms, max_diff_lines, max_diff_files, run_timeout_ms, models,
               model_by, poll_interval_ms, tick_ms, heartbeat_ms, lease_ms, workers, phases_auto_approve, hold_policy,
               alarm_repeat_count, alarm_window_minutes, alarm_restart_count, standing_approvals.threshold, mode,
               auto_merge_max_tier, message_style (a JSON string, at most 1000 characters, egress-scanned). No restart. Every set and reset is audited; PR-only keys (plugins, repo, store,
               floors, dials, auth, guards) are refused. mode, auto_merge_max_tier and a change that loosens a
               tighten-only key need approve_merge.
               --project <owner/name> for max_attempts, max_diff_lines, max_diff_files (tighten only) and mode
  mode auto|manual [--project <owner/name>]
               settings set mode: auto approves specs below tier 4 with no owner-only decision and merges
               reviewed local changes up to auto_merge_max_tier (never tier 4 or the gate list); manual
               waits for a person. Needs approve_merge; audited; a red main, a failure alarm or a budget
               checkpoint sets it back to manual`,
  async run(args, ctx) {
    // `factory mode auto|manual [--project <owner/name>]` is `settings set mode <mode>` (design 03-risk).
    const isMode = ctx.name === "mode";
    const action = isMode ? parseModeArgs([...args]) : parseSettingsArgs([...args]);
    if ("error" in action) {
      console.log(`${action.error}\n${isMode ? MODE_USAGE : SETTINGS_USAGE}`);
      return 1;
    }
    const loaded = await ctx.load();
    const identity = cliIdentity(cliUserConfig(loaded.file), await cliEnvironment(loaded.root));
    await mkdir(join(loaded.stateDir, "db"), { recursive: true, mode: 0o700 });
    const store = await buildStatsStore(loaded);
    try {
      // The configured egress scanner (G5): a message_style it flags is refused before anything is stored.
      const plugins = new Plugins(loaded);
      const scanner = await plugins.scanner(await plugins.secrets());
      // Refuses on MySQL while schema steps are pending, as the other commands do.
      await store.migrate();
      const { owner, name } = loaded.config.repo;
      const r = await runSettings(
        {
          store,
          base: settingsBase(loaded),
          repo: { owner, name },
          // Only for --project: the configured repo's key, from the store, else the forge (design 2026-11-07); with no
          // GitHub plugin selected, the local key (design 05-sources, Local startup).
          resolveProject: async () => {
            const stored = await storeProjectResolver(store, { owner, name })();
            if (stored) return stored;
            if (loaded.config.local_only) return localProject({ owner, name });
            return resolveProject(await new Plugins(loaded).githubApi(), { owner, name });
          },
          // An ID, never a display name: the CLI identity (issue #318), the one the approve_merge check asks about.
          actor: identity.user,
          mayApproveMerge: await approveMergeCheck(loaded, store, identity.user),
          scanner,
        },
        action,
      );
      for (const line of r.lines) console.log(line);
      return r.ok ? 0 : 1;
    } finally {
      await store.close();
    }
  },
});
