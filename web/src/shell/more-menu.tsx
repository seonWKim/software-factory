import { useQueryClient } from "@tanstack/react-query";
import { Monitor, Moon, RotateCw, Sun } from "lucide-react";
import { OverflowMenu } from "../components/ui/menu.js";
import { t } from "../i18n/index.js";
import { type ThemeChoice, chooseTheme, useThemeChoice } from "../theme.js";

/** The theme choices, as Settings' Appearance card lists them, each with its icon. */
const THEMES = [
  { id: "system", label: "theme.system", icon: Monitor },
  { id: "light", label: "theme.light", icon: Sun },
  { id: "dark", label: "theme.dark", icon: Moon },
] as const satisfies readonly { id: ThemeChoice; label: string; icon: unknown }[];

/**
 * The top bar's More menu (design 09-dashboard-shell): Refresh (`r`), then the Appearance group, System, Light and Dark
 * with the current one checked, which applies at once as Settings' Appearance card does.
 */
export function MoreMenu() {
  const client = useQueryClient();
  const theme = useThemeChoice();
  return (
    <OverflowMenu
      label={t("topbar.more")}
      items={[
        { label: t("topbar.refresh"), icon: RotateCw, shortcut: "r", action: "refresh", onSelect: () => void client.invalidateQueries() },
        { separator: true },
        { group: t("theme.title") },
        ...THEMES.map(({ id, label, icon }) => ({ label: t(label), icon, checked: theme === id, action: `theme ${id}`, onSelect: () => chooseTheme(id) })),
      ]}
    />
  );
}
