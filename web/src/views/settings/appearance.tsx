import { useEffect } from "react";
import { Card } from "../../components/ui/card.js";
import { SegmentedControl } from "../../components/ui/segmented-control.js";
import { t } from "../../i18n/index.js";
import { SETTINGS_INTRO } from "./rows.js";
import { type ThemeChoice, chooseTheme, useThemeChoice } from "../../theme.js";

/** Settings' Appearance anchor: `settings#appearance`. */
export const APPEARANCE_ANCHOR = "appearance";

/**
 * The theme for this browser (design 09-dashboard-shell, 2026-11-24): System, Light or Dark in one SegmentedControl.
 * It moved here from the top bar, which keeps only what matters at a glance; the choice applies at once.
 */
export function AppearanceSection() {
  const choice = useThemeChoice();
  // Opened from the top bar's More menu (`#appearance`): the card scrolls into view once drawn.
  useEffect(() => {
    if (window.location.hash === `#${APPEARANCE_ANCHOR}`) document.getElementById(APPEARANCE_ANCHOR)?.scrollIntoView?.();
  }, []);
  return (
    <Card id={APPEARANCE_ANCHOR} title={t("theme.title")}>
      <p className={SETTINGS_INTRO}>{t("theme.hint")}</p>
      <SegmentedControl<ThemeChoice>
        label={t("theme.label")}
        options={[
          { id: "system", label: t("theme.system") },
          { id: "light", label: t("theme.light") },
          { id: "dark", label: t("theme.dark") },
        ]}
        value={choice}
        onChange={chooseTheme}
      />
    </Card>
  );
}
