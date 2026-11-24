// The dependencies the dashboard's JSON API reads through, and the token count of a run.

import type { SkillImproveWiring, holdSkillDraft, promoteSkillDraft, rejectSkillDraft } from "../core/skill-improve.js";
import { type Run, outcomeTokens } from "../core/types.js";
import type { Clock } from "../interfaces/clock.js";
import type { EgressScanner } from "../interfaces/egress-scanner.js";
import type { FactoryStore } from "../interfaces/factory-store.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import type { SharedStorage } from "../interfaces/shared-storage.js";
import type { UiChanges } from "./changes.js";
import type { UiCommands } from "./commands.js";
import type { FactoryStatus } from "./factory-status.js";
import type { HealthMonitor } from "./health.js";
import type { DisplayNames } from "./names.js";
import type { UiTacit } from "./rules-api.js";
import type { UiSettings } from "./settings-api.js";

export interface UiDeps {
  store: FactoryStore;
  scanner: EgressScanner;
  clock: Clock;
  /** Running runs whose last heartbeat is older than this are highlighted. */
  lease_ms: number;
  /** /api/health and /api/v1/health: doctor's checks, rate-limited and egress-scanned. */
  health: HealthMonitor;
  /** The supervisor's state (null: no status file); absent: the banner is not shown. */
  factoryStatus?: () => Promise<FactoryStatus | null>;
  /** Which plugins are in use, for the app's Issue column. Absent: null. */
  plugins?: { issues: "github" | null };
  /** The built app served under /app/; absent: web/dist in this checkout. */
  appDir?: string;
  /**
   * The Settings routes (GET and POST /api/v1/settings; design §8, issue #236): the config base, the repo, the
   * actor, a store-only project resolver and the per-process CSRF token. Absent: GET is a 404 and POST a 405.
   */
  settings?: UiSettings;
  /**
   * Where the worker stores run transcripts (`transcripts/<item>/<run>.json`), read back one byte range at a
   * time for the app's transcript view (design §9, issue #303). Absent: no run has a transcript link and the
   * transcript route is a 404.
   */
  storage?: SharedStorage;
  /**
   * The item commands route (POST /api/v1/items/:id/commands and GET /api/v1/session; issue #227): the actor
   * and the per-process token. Absent: the session is a 404 and a commands POST a 503.
   */
  commands?: UiCommands;
  /** Display names by user id (Identity's identity_profiles), read only to show. Absent: ids only. */
  displayNames?: DisplayNames;
  /**
   * The sandbox's trusted readChanges on the factory repo and its base (changes.ts): the item page's Changes tab and the
   * Merge check card's Re-check. Absent: no Changes tab and no Re-check.
   */
  changes?: UiChanges;
  /** The Rules page's tacit ledger (rules-api.ts, issue #571), read and judged only through it. Absent: the plugin `none`. */
  tacit?: UiTacit;
  /** A skill draft's verdicts on the Rules page (rules-api.ts writeSkillVerdict): compose.ts buildUiParts. Absent: each is refused. */
  skillImprove?: UiSkillImprove;
  /**
   * The configured model (plugins.llm) for a schedule's Draft and Improve (schedules-api.ts). Absent or null: the Data
   * page's Ask model, the same plugin compose.ts buildUiParts builds (settings.ask.llm), else both answer 503.
   */
  llm?: LLMProvider | null;
}

/** The UI process's model: `llm`, else the Data page's Ask model (the same plugin, built by buildUiParts); null: none. */
export const uiModel = (d: Pick<UiDeps, "llm" | "settings">): LLMProvider | null => d.llm ?? d.settings?.ask?.llm ?? null;

/**
 * The skill draft verdicts (src/core/skill-improve.ts), passed in by the composition root as the eval functions are,
 * so no route imports the core, and Promote's wiring: undefined without capabilities.skill_folders or a model.
 */
export interface UiSkillImprove {
  hold: typeof holdSkillDraft;
  reject: typeof rejectSkillDraft;
  promote: typeof promoteSkillDraft;
  wiring: SkillImproveWiring | undefined;
}

/**
 * Tokens a run used, the same count the controller adds to token_cost (design §6 Measurement): a succeeded
 * run's data.tokens, a failed run's usage. Null when the run stored none (unfinished, or an older failed row).
 */
export function runTokens(run: Run): number | null {
  // A person's session reports its own total (design §5, 2026-11-01).
  if (run.kind === "interactive") return run.session_tokens;
  if (run.outcome?.status === "succeeded") {
    const t = Number(run.outcome.data.tokens);
    return Number.isFinite(t) && t >= 0 ? t : null;
  }
  return run.outcome?.status === "failed" && run.outcome.usage ? outcomeTokens(run.outcome) : null;
}
