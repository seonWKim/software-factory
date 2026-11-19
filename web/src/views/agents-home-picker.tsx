import { useState } from "react";
import type { AgentsHomeView } from "../api.js";
import { Field } from "../components/ui/field.js";
import { Notice } from "../components/ui/notice.js";
import { Radio } from "../components/ui/radio.js";
import { t } from "../i18n/index.js";

// The agents home picker the Rules page (ledger off) and the Settings Turn on dialog both render: the known homes
// (AGENTS_HOME when set, ~/.agents) with the one in use chosen first, and the chosen one's check. Choosing stores nothing.

/** The chosen home's check: both CLIs executable, else the first missing file; and whether the ledger reads it. */
function HomeCheck({ home, inUse }: { home: AgentsHomeView; inUse: string }) {
  return (
    <div data-home-check className="space-y-2">
      {home.missing === null ? (
        <Notice tone="ok">{t("rules.homeOk", { path: home.path })}</Notice>
      ) : (
        <Notice tone="warn">{t("rules.homeMissingFile", { file: home.missing, path: home.path })}</Notice>
      )}
      {home.path !== inUse && <p className="text-xs text-pretty text-text-2">{t("rules.homeNotUsed", { path: inUse })}</p>}
    </div>
  );
}

export function AgentsHomePicker({ home }: { home: AgentsHomeView & { homes?: AgentsHomeView[] } }) {
  const homes = home.homes ?? [home];
  const [chosen, setChosen] = useState(home.path);
  const shown = homes.find((h) => h.path === chosen) ?? home;
  return (
    <div data-home className="space-y-2">
      <Field label={t("rules.homePick")} help={t("rules.homePickHelp")}>
        <div role="radiogroup" aria-label={t("rules.homePick")} className="space-y-1">
          {homes.map((h) => (
            <Radio key={h.path} name="agents-home" value={h.path} checked={h.path === chosen} onChange={() => setChosen(h.path)}>
              <span className="font-mono break-all">{h.path === home.path ? t("rules.homeInUse", { path: h.path }) : h.path}</span>
            </Radio>
          ))}
        </div>
      </Field>
      <HomeCheck home={shown} inUse={home.path} />
    </div>
  );
}
