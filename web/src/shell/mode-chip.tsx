import { API, type SettingsView, useApi } from "../api.js";
import { Badge } from "../components/ui/badge.js";
import { FOCUS } from "../components/ui/control.js";
import { Tooltip } from "../components/ui/menu.js";
import { t } from "../i18n/index.js";
import { cn } from "../lib/cn.js";
import { Link } from "../nav.js";
import { BASE } from "../pages.js";
import { MODE_ANCHOR, autoStopText, currentMode } from "../views/settings/general.js";

/** The configured project's auto-merge tier (its own value when it has one), or null when the key is not listed. */
function mergeTier(v: SettingsView): string | null {
  const row = v.keys.find((k) => k.key === "auto_merge_max_tier");
  if (!row) return null;
  const own = v.project === null ? undefined : row.projects.find((p) => p.project === v.project);
  return own?.value ?? row.value;
}

/**
 * The top bar's mode status (design 09-dashboard-shell, 2026-11-22): "Auto · merges ≤ tier N" or "Manual" in a Badge,
 * a link to Settings' Mode section. It only shows the mode; the mode changes in Settings, behind a confirmation.
 */
export function ModeChip() {
  const v = useApi<SettingsView>(API.settings).data;
  const mode = v ? currentMode(v) : null;
  if (!v || !mode) return <span className="text-sm text-text-2">{t("settings.modeLoading")}</span>;
  const auto = mode.value === '"auto"';
  const tier = mergeTier(v);
  const label = !auto ? t("topbar.modeManual") : tier === null ? t("topbar.modeAuto") : t("topbar.modeAutoTier", { tier });
  return (
    <Tooltip placement="bottom" align="start" text={<>{v.auto_stop && <span className="mb-1 block">{autoStopText(v.auto_stop)}</span>}{t("settings.modeAutoHint")}</>}>
      <Link data-testid="mode" href={`${BASE}settings#${MODE_ANCHOR}`} aria-label={t("topbar.modeLink", { mode: label })} className={cn("inline-flex shrink-0 rounded-pill", FOCUS)}>
        <Badge level={auto ? "running" : undefined}>{label}</Badge>
      </Link>
    </Tooltip>
  );
}
