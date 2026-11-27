import type { ReactNode } from "react";
import type { ItemDetail } from "../api.js";
import { Card, SUB_TITLE } from "../components/ui/card.js";
import { Disclosure } from "../components/ui/disclosure.js";
import { t } from "../i18n/index.js";
import { cn } from "../lib/cn.js";
import { ItemChecks } from "./item-checks.js";

// The item page's About (docs/design/09-dashboard-item.md): the body's first paragraph as the request, the done-when lines with
// their checks and latest results, and the approved spec collapsed below them (without its done-when list while the
// checks show it). A text the API withheld (`[withheld: <rule>]`) shows the withheld note, never the marker.

const TEXT = "text-sm text-pretty break-words whitespace-pre-line max-w-[75ch]";

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
    <div data-about-part className="mt-3 min-w-0">
      <h3 className={SUB_TITLE}>{label}</h3>
      {children}
    </div>
  );
}

/** About under the item's title; nothing when the item has no request, no approved spec and no checks. */
export function ItemAbout({ item }: { item: Pick<ItemDetail["item"], "request" | "spec" | "checks"> }) {
  const request = item.request ?? null;
  const spec = item.spec ?? null;
  const checks = item.checks?.length ? item.checks : null;
  if (request === null && spec === null && checks === null) return null;
  return (
    <Card title={t("item.about")}>
      {request !== null && <div data-about-request><AboutText value={request} /></div>}
      {checks !== null && (
        <div data-about-checks className={request !== null ? "mt-3 min-w-0" : "min-w-0"}>
          <h3 className={cn("mb-1", SUB_TITLE)}>{t("item.checks")}</h3>
          <ItemChecks checks={checks} />
        </div>
      )}
      {spec !== null && (
        <Disclosure data-about-spec className={request !== null || checks !== null ? "mt-3" : undefined} summary={t("item.aboutSpec")}>
          <Part label={t("spec.problem")}><AboutText value={spec.problem} /></Part>
          {spec.desired_output !== null && <Part label={t("spec.desired_output")}><AboutText value={spec.desired_output} /></Part>}
          {checks === null && spec.done_criteria.length > 0 && (
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
