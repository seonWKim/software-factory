import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { PROPOSALS_API, type ProposalVerdict, type SkillDraftRow, postSkillVerdict } from "../api/proposals.js";
import { StatusBadge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { CardSection } from "../components/ui/card.js";
import { Dialog, announceStatus } from "../components/ui/dialog.js";
import { ListRow } from "../components/ui/list-row.js";
import { OverflowMenu } from "../components/ui/menu.js";
import type { MessageKey } from "../i18n/en.js";
import { t } from "../i18n/index.js";
import { localDateTime, relativeTime } from "../lib/format.js";
import { LIST, PROSE, ROW_PAD, VERDICTS, WRAP_TITLE, muted, waitPill } from "./rules-shared.js";

// Skill changes on the Rules page (design 09-dashboard-rules-waiting): the improve run's skill drafts that wait for a
// verdict, read from GET /api/v1/proposals (`skills`, the same list as the entity proposals). Each is a ListRow with its
// skill, a Held pill when held (a proposed draft has none: its section says it waits), when it was drafted, the checks it
// was drafted against and its test score now and with the change; Promote is visible at the right of its title and the
// ⋯ menu lists the other verdicts the draft offers (Hold only while proposed). Promote and Reject
// ask first in a Dialog; Hold acts at once. A verdict is POST /api/v1/rules/skill-verdict with the owner's token; a
// refusal (the core's reason) shows in the dialog, or under the row for Hold. Only the owner gets the menu and button.

const pct = (v: number | null) => (v === null ? t("rules.skillNotMeasured") : `${Math.round(v * 100)}%`);
const CONFIRM: Readonly<Record<"promote" | "reject", { title: MessageKey; consequence: MessageKey }>> = {
  promote: { title: "rules.skillConfirmPromote", consequence: "rules.skillConsequencePromote" },
  reject: { title: "rules.skillConfirmReject", consequence: "rules.skillConsequenceReject" },
};

/** The drafts that offer a verdict: proposed or held. */
export const waitingSkills = (rows: readonly SkillDraftRow[] | undefined): SkillDraftRow[] => (rows ?? []).filter((s) => s.verdicts.length > 0);

function SkillRow({ draft, token }: { draft: SkillDraftRow; token: string | null }) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [asking, setAsking] = useState<"promote" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const menu = useRef<HTMLDivElement>(null);
  const promote = useRef<HTMLButtonElement>(null);
  const [from, setFrom] = useState<"button" | "menu">("menu");
  const returnFocusTo = { get current() { return from === "button" ? promote.current : (menu.current?.querySelector<HTMLElement>("button[aria-haspopup]") ?? null); } };
  const title = t("rules.skillTitle", { skill: draft.skill_ref });
  /** Sends the verdict; true once taken (the list reloads), false with the refusal shown where it was asked. */
  const decide = async (verdict: ProposalVerdict, show: (message: string) => void): Promise<boolean> => {
    if (token === null) return false;
    setBusy(true);
    setNote(null);
    try {
      const r = await postSkillVerdict(token, { id: draft.id, verdict });
      if (!r.ok) {
        show(r.error);
        return false;
      }
      announceStatus(t("rules.skillDone", { title, state: r.state }));
      await client.invalidateQueries({ queryKey: [PROPOSALS_API.list] });
      return true;
    } catch (err) {
      show(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const ask = (verdict: "promote" | "reject", origin: "button" | "menu") => {
    setFrom(origin);
    setError(null);
    setAsking(verdict);
  };
  const decides = token !== null && draft.verdicts.length > 0;
  const pill = waitPill(draft.state);
  return (
    <ListRow
      data-skill-draft={draft.id}
      className={ROW_PAD}
      title={<p className={WRAP_TITLE}>{title}</p>}
      details={
        <>
          {pill !== null && <StatusBadge state={pill} />}
          <span title={localDateTime(draft.created_at)}>{relativeTime(draft.created_at, Date.now())}</span>
          <span data-skill-score className="break-keep">{t("rules.skillScore", { before: pct(draft.before), after: pct(draft.after) })}</span>
        </>
      }
      action={decides && draft.verdicts.includes("promote") && <Button ref={promote} size="sm" disabled={busy} onClick={() => ask("promote", "button")}>{t("rules.promote")}</Button>}
      menu={
        decides && draft.verdicts.some((v) => v !== "promote") && (
          <div ref={menu}>
            <OverflowMenu
              label={t("rules.actions", { title })}
              items={VERDICTS.filter((v) => v.verdict !== "promote" && draft.verdicts.includes(v.verdict as ProposalVerdict)).map((v) => ({
                label: t(v.label), action: v.verdict, danger: v.variant === "danger", disabled: busy,
                onSelect: () => (v.verdict === "hold" ? void decide("hold", setNote) : ask(v.verdict as "promote" | "reject", "menu")),
              }))}
            />
          </div>
        )
      }
    >
      {draft.why !== null && <p className={`${PROSE} ${muted}`}>{t("rules.skillWhy", { checks: draft.why })}</p>}
      {note && <p role="alert" className="text-xs text-pretty break-words text-text-2">{note}</p>}
      {asking !== null && (
        <Dialog
          title={t(CONFIRM[asking].title, { title })}
          consequence={t(CONFIRM[asking].consequence)}
          confirmLabel={t(asking === "promote" ? "rules.promote" : "rules.reject")}
          confirmDisabled={busy}
          danger={asking === "reject"}
          error={error}
          onConfirm={() => void decide(asking, setError).then((done) => done && setAsking(null))}
          onClose={() => setAsking(null)}
          returnFocusTo={returnFocusTo}
        />
      )}
    </ListRow>
  );
}

/** The waiting skill drafts as one section of Waiting for you; nothing when none waits. What promoting one does is under the card's "How promoting works". */
export function SkillDrafts({ rows, token }: { rows: SkillDraftRow[]; token: string | null }) {
  if (rows.length === 0) return null;
  return (
    <CardSection title={t("rules.groupSkills")}>
      <ul aria-label={t("rules.groupSkills")} className={LIST}>
        {rows.map((s) => <SkillRow key={s.id} draft={s} token={token} />)}
      </ul>
    </CardSection>
  );
}
