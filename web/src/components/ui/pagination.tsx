import { t } from "../../i18n/index.js";
import { Button } from "./button.js";

// The dashboard's one pager (docs/design/09-dashboard-app.md): Previous and Next, the shared Button, around a
// "Page x of y" label. Pages count from 1. It renders nothing when everything fits on one page.
export function Pagination({ page, pages, onChange }: { page: number; pages: number; onChange: (page: number) => void }) {
  if (pages <= 1) return null;
  return (
    <nav aria-label={t("pagination.label")} className="flex items-center justify-between gap-2">
      <Button disabled={page <= 1} onClick={() => onChange(page - 1)}>
        {t("pagination.previous")}
      </Button>
      <span className="text-xs text-text-2 tabular-nums" aria-live="polite">
        {t("pagination.page", { page, pages })}
      </span>
      <Button disabled={page >= pages} onClick={() => onChange(page + 1)}>
        {t("pagination.next")}
      </Button>
    </nav>
  );
}
