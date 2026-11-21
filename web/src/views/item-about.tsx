import type { ReactNode } from "react";
import type { ItemDetail } from "../api.js";
import { Card } from "../components/ui/card.js";
import { Disclosure } from "../components/ui/disclosure.js";
import { t } from "../i18n/index.js";

// The item page's About (docs/design/09-dashboard-item.md): the request's first paragraph, and the approved spec
// collapsed below it. A text the API withheld (`[withheld: <rule>]`) shows the withheld note, never the marker.

const TEXT = "text-sm text-pretty break-words whitespace-pre-line";

/** One text of About, or the withheld note in its place. */
function AboutText({ value, as: As = "p" }: { value: string; as?: "p" | "li" }) {
  const withheld = value.startsWith("[withheld: ");
  return (
    <As data-withheld={withheld ? "" : undefined} className={TEXT}>
      {withheld ? <em className="text-text-2">{t("item.aboutWithheld")}</em> : value}
    </As>
  );
}

/** A labelled part of the spec. */
function Part({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mt-3 min-w-0">
      <h3 className="text-xs text-text-2">{label}</h3>
      {children}
    </div>
  );
}

/** About under the item's title; nothing when the item has neither a request nor an approved spec. */
export function ItemAbout({ item }: { item: Pick<ItemDetail["item"], "request" | "spec"> }) {
  const request = item.request ?? null;
  const spec = item.spec ?? null;
  if (request === null && spec === null) return null;
  return (
    <Card title={t("item.about")}>
      {request !== null && <div data-about-request><AboutText value={request} /></div>}
      {spec !== null && (
        <Disclosure data-about-spec className={request !== null ? "mt-3" : undefined} summary={t("item.aboutSpec")}>
          <Part label={t("spec.problem")}><AboutText value={spec.problem} /></Part>
          {spec.desired_output !== null && <Part label={t("spec.desired_output")}><AboutText value={spec.desired_output} /></Part>}
          {spec.done_criteria.length > 0 && (
            <Part label={t("spec.done_criteria")}>
              <ul aria-label={t("spec.done_criteria")} className="list-disc space-y-1 pl-6">
                {spec.done_criteria.map((c, i) => <AboutText key={i} as="li" value={c} />)}
              </ul>
            </Part>
          )}
        </Disclosure>
      )}
    </Card>
  );
}
