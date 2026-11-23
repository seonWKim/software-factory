import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { API, type ItemChanges, type Session, postRecheck, useApi, useManualApi } from "../api.js";
import { Button } from "../components/ui/button.js";
import { Card } from "../components/ui/card.js";
import { ListRow, ROW_TITLE } from "../components/ui/list-row.js";
import { EmptyState } from "../components/ui/notice.js";
import { ErrorNote, Loading } from "../components/ui/parts.js";
import { ALERT } from "./tasks/shared.js";
import { t } from "../i18n/index.js";
import { cn } from "../lib/cn.js";

// The item page's Changes tab (design 09-dashboard-item): the files the item's branch changes against the base, each
// with its added and removed line counts, and the chosen file's diff on the page. Read once (GET
// /api/v1/items/:id/changes, no polling); the server reads git objects already in the factory repo and scans every path
// and diff. A withheld diff shows the withheld marker in its place; a diff past 256 KiB ends with a Truncated note.

/** A diff line's colour: added and removed lines in the pill tokens, the rest plain. */
function lineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "text-text-2";
  if (line.startsWith("+")) return "text-pill-ok-fg";
  if (line.startsWith("-")) return "text-pill-bad-fg";
  return line.startsWith("@@") ? "text-text-2" : "";
}

/** The chosen file's diff, read when it is chosen. */
function FileDiff({ id, path }: { id: string; path: string }) {
  const q = useManualApi<ItemChanges>(API.itemChanges(id, path));
  const file = q.data?.file;
  return (
    <Card title={t("item.fileChanges", { path })}>
      {q.isError ? <ErrorNote error={q.error} /> : !file ? <Loading rows={4} /> : (
        <div className="space-y-2">
          <pre data-diff data-withheld={file.withheld || undefined} className="max-h-[70vh] overflow-auto rounded-control border border-border bg-surface-2 p-2 font-mono text-xs">
            {file.withheld ? file.diff : file.diff.split("\n").map((l, i) => <span key={i} className={cn("block whitespace-pre", lineClass(l))}>{l || " "}</span>)}
          </pre>
          {file.truncated && <p data-truncated className="text-xs text-text-2">{t("item.truncated")}</p>}
        </div>
      )}
    </Card>
  );
}

/** The Changes tab: the changed files as list rows (the path, then its counts), then the chosen file's diff below it. */
export function ItemChangesTab({ id }: { id: string }) {
  const q = useManualApi<ItemChanges>(API.itemChanges(id));
  const [picked, pick] = useState<string | null>(null);
  if (q.isError) return <ErrorNote error={q.error} />;
  if (!q.data) return <Loading rows={4} />;
  const files = q.data.files;
  return (
    <>
      <Card title={t("item.changedFiles")} count={files.length}>
        {files.length === 0 ? <EmptyState title={t("item.noChanges")} /> : (
          <ul aria-label={t("item.changedFiles")} className="divide-y divide-border rounded-control border border-border">
            {files.map((f) => (
              <ListRow
                key={f.path}
                data-file={f.path}
                className={cn(picked === f.path && "bg-surface-2")}
                title={
                  // The path stays the row's title text; the shared Button lies over it, so the row keeps its height.
                  <p title={f.path} className={cn(ROW_TITLE, "relative font-mono hover:underline")}>
                    {f.path}
                    <Button
                      variant="ghost"
                      aria-pressed={picked === f.path}
                      aria-label={t("item.fileChanges", { path: f.path })}
                      className="absolute inset-0 min-h-0! px-0! enabled:hover:bg-transparent!"
                      onClick={() => pick(f.path)}
                    />
                  </p>
                }
                details={f.added === null || f.removed === null ? <span>{t("item.binary")}</span> : (
                  <span className="tabular-nums" title={t("item.lines", { added: f.added, removed: f.removed })}>
                    <span data-added className="text-pill-ok-fg">+{f.added}</span> <span data-removed className="text-pill-bad-fg">−{f.removed}</span>
                  </span>
                )}
              />
            ))}
          </ul>
        )}
        {files.length > 0 && picked === null && <p className="mt-2 text-xs text-text-2">{t("item.pickFile")}</p>}
      </Card>
      {picked !== null && <FileDiff key={picked} id={id} path={picked} />}
    </>
  );
}

/**
 * The Merge check card's Re-check (a stored check older than the base's last commit): removes the stored check, then
 * reloads the item, whose card reads checking until the factory checks it again. A refusal shows below the button.
 */
export function RecheckButton({ id }: { id: string }) {
  const client = useQueryClient();
  const token = useApi<Session>(API.session, false).data?.csrf_token ?? null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async () => {
    if (token === null) return;
    setBusy(true);
    setError(null);
    try {
      const r = await postRecheck(token, id);
      if (r.ok) await Promise.all([client.invalidateQueries({ queryKey: [API.item(id)] }), client.invalidateQueries({ queryKey: [API.items] })]);
      else setError(r.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-2 space-y-1">
      <p className="text-xs text-text-2">{t("item.recheckWhy")}</p>
      <Button size="sm" data-recheck disabled={token === null || busy} onClick={() => void send()}>{t("item.recheck")}</Button>
      {error !== null && <p role="alert" className={ALERT}>{error}</p>}
    </div>
  );
}
