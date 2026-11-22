import { Dialog } from "../../components/ui/dialog.js";
import { t } from "../../i18n/index.js";

export type ModeTarget = "auto" | "manual";

/**
 * The one confirmation before the mode changes (design 09-dashboard-settings, 2026-11-22): the Settings Mode switch
 * and "Turn auto back on" (Settings' auto-stop note and the alarm row in Needs you) open it. Nothing is written until
 * Confirm; Cancel, Escape and the backdrop write nothing. A refused write keeps it open with the server's reason.
 */
export function ModeDialog({ to, busy, error, onConfirm, onClose }: { to: ModeTarget; busy: boolean; error: string | null; onConfirm: () => void; onClose: () => void }) {
  const auto = to === "auto";
  return (
    <Dialog
      title={t(auto ? "settings.modeConfirmAutoTitle" : "settings.modeConfirmManualTitle")}
      consequence={t(auto ? "settings.modeAutoHint" : "settings.modeLineManual")}
      confirmLabel={t(auto ? "settings.modeConfirmAuto" : "settings.modeConfirmManual")}
      confirmDisabled={busy}
      error={error}
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
}
