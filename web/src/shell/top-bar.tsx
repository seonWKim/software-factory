import { Monitor, Moon, Sun } from "lucide-react";
import { OverflowMenu } from "../components/ui/menu.js";
import { type MessageKey } from "../i18n/en.js";
import { t } from "../i18n/index.js";
import { type ThemeChoice } from "../theme.js";

const THEME_CHOICES: readonly { choice: ThemeChoice; label: MessageKey }[] = [
  { choice: "system", label: "topbar.themeSystem" },
  { choice: "light", label: "topbar.themeLight" },
  { choice: "dark", label: "topbar.themeDark" },
];

/** One Theme button that opens System, Light and Dark, the current choice checked. */
export function ThemeControl({ choice, onChoose }: { choice: ThemeChoice; onChoose: (c: ThemeChoice) => void }) {
  const Icon = choice === "light" ? Sun : choice === "dark" ? Moon : Monitor;
  return (
    <OverflowMenu
      label={t("topbar.theme")}
      icon={<Icon aria-hidden className="size-4" />}
      items={THEME_CHOICES.map(({ choice: c, label }) => ({ label: t(label), checked: choice === c, onSelect: () => onChoose(c) }))}
    />
  );
}
