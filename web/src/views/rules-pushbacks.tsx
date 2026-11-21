import { useState } from "react";
import { type PushbackRow, type RulesView, postPushbackDismiss } from "../api.js";
import { Button } from "../components/ui/button.js";
import { Card } from "../components/ui/card.js";
import { Dialog } from "../components/ui/dialog.js";
import { ListRow, ROW_TITLE } from "../components/ui/list-row.js";
import { Tooltip } from "../components/ui/menu.js";
import { Notice } from "../components/ui/notice.js";
import { t } from "../i18n/index.js";
import { PROSE, ROW_PAD, muted } from "./rules-shared.js";
import { useSend } from "./rules-verdict.js";

// The Rules page's Pushbacks card (design 09-dashboard-rules.md): the active pushbacks the ledger has not put in a rule
// candidate yet, after Applied in the Applied tab. Each row shows the owner's words and the day when given, never the
// pushback's ID, and one secondary Dismiss, which opens a dialog and records the pushback as noise (off, with the
// owner-only tooltip, for anyone but the owner). A list the server could not read is a Notice; the rest of the page
// loads.

/** Dismiss: says it records the pushback as noise, then sends it; the list reloads without it. */
function DismissDialog({ row, token, onClose }: { row: PushbackRow; token: string; onClose: () => void }) {
  const { busy, error, send } = useSend(onClose);
  const label = t("rules.dismiss");
  return (
    <Dialog
      title={t("rules.dialogTitle", { label, title: row.pushback })}
      consequence={t("rules.consequenceDismiss")}
      confirmLabel={label}
      confirmDisabled={busy}
      error={error}
      onConfirm={() => void send(() => postPushbackDismiss(token, { id: row.id }), t("rules.dismissed"))}
      onClose={onClose}
    />
  );
}

/** One pushback: the owner's words on one line (all of them in its tooltip), the day, and Dismiss. */
function Pushback({ row, token }: { row: PushbackRow; token: string | null }) {
  const [open, setOpen] = useState(false);
  const dismiss = (
    <Button size="sm" variant="secondary" disabled={token === null} onClick={() => setOpen(true)}>
      {t("rules.dismiss")}
    </Button>
  );
  return (
    <ListRow
      data-pushback
      className={ROW_PAD}
      title={
        <p data-pushback-words className={ROW_TITLE} title={row.pushback}>
          {row.pushback}
        </p>
      }
      details={row.date !== null && <span className="tabular-nums">{row.date}</span>}
      menu={token === null ? <Tooltip text={t("rules.dismissOwner")} align="end">{dismiss}</Tooltip> : dismiss}
    >
      {open && token !== null && <DismissDialog row={row} token={token} onClose={() => setOpen(false)} />}
    </ListRow>
  );
}

/** The Pushbacks card: its count is the number of rows; a failed read is a Notice, an empty list one line. */
export function Pushbacks({ pushbacks, token }: { pushbacks: NonNullable<RulesView["pushbacks"]>; token: string | null }) {
  const { rows, error } = pushbacks;
  return (
    <Card title={t("rules.groupPushbacks")} count={rows.length}>
      <div className="space-y-2">
        <p data-group-line className={`${PROSE} ${muted}`}>
          {t("rules.pushbacksLine")}
        </p>
        {error !== null && <Notice tone="warn">{t("rules.pushbacksUnread")}</Notice>}
        {error === null && rows.length === 0 && <p className={muted}>{t("rules.pushbacksNone")}</p>}
        {rows.length > 0 && (
          <ul aria-label={t("rules.groupPushbacks")} className="divide-y divide-border rounded-control border border-border">
            {rows.map((r) => (
              <Pushback key={r.id} row={r} token={token} />
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
