import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { API, type ItemChanges as ItemChangesRead, type Session, postRecheck, useApi, useManualApi } from "../api.js";
import { Button } from "../components/ui/button.js";
import { Card, CardSection } from "../components/ui/card.js";
import { ListRow, ROW_TITLE } from "../components/ui/list-row.js";
import { EmptyState, Notice } from "../components/ui/notice.js";
import { ErrorNote, Loading } from "../components/ui/parts.js";
import { ALERT } from "./tasks/shared.js";
import { t } from "../i18n/index.js";
import { cn } from "../lib/cn.js";
import { SCREENSHOT_SIZES, SCREENSHOT_THEMES } from "../../../src/shared/screenshots.js";

// The item page's Changes tab (design 09-dashboard-item): the files the item's branch changes against the base, each
// with its added and removed line counts, and the chosen file's diff on the page. Read once (GET
// /api/v1/items/:id/changes, no polling); the server reads git objects already in the factory repo and scans every path
// and diff. A withheld diff shows the withheld marker in its place; a diff past 256 KiB ends with a Truncated note.
// Below them, ItemChanges shows the screenshot run's images and the screenshot review (design 04-screenshots).

/** A diff line's colour: added and removed lines in the pill tokens, the rest plain. */
function lineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "text-text-2";
  if (line.startsWith("+")) return "text-pill-ok-fg";
  if (line.startsWith("-")) return "text-pill-bad-fg";
  return line.startsWith("@@") ? "text-text-2" : "";
}

/** The chosen file's diff, read when it is chosen. */
function FileDiff({ id, path }: { id: string; path: string }) {
  const q = useManualApi<ItemChangesRead>(API.itemChanges(id, path));
  const file = q.data?.file;
  return (
    <Card title={t("item.fileChanges", { path })}>
      {q.isError ? <ErrorNote error={q.error} /> : !file ? <Loading rows={4} label="loading.fileDiff" onRetry={() => void q.refetch()} /> : (
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
  const q = useManualApi<ItemChangesRead>(API.itemChanges(id));
  const [picked, pick] = useState<string | null>(null);
  if (q.isError) return <ErrorNote error={q.error} />;
  if (!q.data) return <Loading rows={4} label="loading.changedFiles" onRetry={() => void q.refetch()} />;
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
                  // The path stays the row's title text; the shared 28px Button lies over it, full width and centred on the title, so the row keeps its height.
                  <p title={f.path} className={cn(ROW_TITLE, "relative font-mono hover:underline")}>
                    {f.path}
                    <Button
                      variant="ghost"
                      aria-pressed={picked === f.path}
                      aria-label={t("item.fileChanges", { path: f.path })}
                      className="absolute inset-x-0 top-1/2 h-7 min-h-0! -translate-y-1/2 px-0! enabled:hover:bg-transparent!"
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

/** The item API's `screenshots` (src/ui/item-screenshots.ts): the newest screenshot run, null when there is none. */
export interface ItemScreenshots {
  run_id: string;
  status: string;
  captures: { page: string; width: number; theme: string; key: string }[];
  reason: string | null;
}

/** The item API's `screenshot_review`: the newest screenshot review, null when none was queued. */
export interface ItemScreenshotReview {
  run_id: string;
  status: string;
  findings: { kind: string; text: string }[];
  unverified: string[];
  summary: string | null;
}

const themeLabel = (theme: string): string => (theme === "dark" ? t("changes.dark") : t("changes.light"));
const ORDER = SCREENSHOT_SIZES.flatMap((s) => SCREENSHOT_THEMES.map((theme) => `${s.width}-${theme}`));
const finished = (status: string): boolean => status !== "queued" && status !== "running";

/**
 * The item page's Changes tab (design 04-screenshots, 09-dashboard-item): the screenshots the factory took of the
 * dashboard's pages after the review passed, by page, then width (390px, 1280px) and theme (light, dark), and what the
 * screenshot review found in them. Token classes only; the Merge button stays outside it, above the tabs' panel.
 */
export function ItemChanges({ itemId, screenshots, review }: { itemId: string; screenshots: ItemScreenshots | null; review: ItemScreenshotReview | null }) {
  const pages = [...new Set((screenshots?.captures ?? []).map((c) => c.page))];
  return (
    <div data-item-changes className="flex flex-col gap-6">
      <Card title={t("changes.screenshots")} count={screenshots?.captures.length}>
        {screenshots === null ? (
          <EmptyState title={t("changes.noScreenshots")} />
        ) : (
          <div className="flex flex-col gap-4">
            {!finished(screenshots.status) && <Notice>{t("changes.waiting")}</Notice>}
            {screenshots.reason !== null && (
              <Notice tone="warn"><span data-raw data-screenshots-reason>{t("changes.notCaptured")} {screenshots.reason}</span></Notice>
            )}
            {pages.length > 0 && <p className="text-sm text-text-2">{t("changes.fixture")}</p>}
            {pages.map((page) => (
              <CardSection key={page} title={page}>
                <ul data-screenshot-page={page} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {screenshots.captures
                    .filter((c) => c.page === page)
                    .sort((a, b) => ORDER.indexOf(`${a.width}-${a.theme}`) - ORDER.indexOf(`${b.width}-${b.theme}`))
                    .map((c) => (
                      <li key={c.key} data-screenshot={`${c.width}-${c.theme}`} className="min-w-0">
                        <Shot itemId={itemId} runId={screenshots.run_id} page={page} width={c.width} theme={c.theme} />
                      </li>
                    ))}
                </ul>
              </CardSection>
            ))}
          </div>
        )}
      </Card>
      <Card title={t("changes.review")} count={review?.findings.length}>
        <ScreenshotReview review={review} />
      </Card>
    </div>
  );
}

/** One screenshot with its caption: the image is read on its own, once (never polled). */
function Shot({ itemId, runId, page, width, theme }: { itemId: string; runId: string; page: string; width: number; theme: string }) {
  const q = new URLSearchParams({ item: itemId, run: runId, page, width: String(width), theme });
  const img = useApi<{ data_url: string }>(`/api/v1/screenshot?${q}`, false);
  const alt = t("changes.shot", { page, width, theme: themeLabel(theme).toLowerCase() });
  return (
    <figure className="flex min-w-0 flex-col gap-1">
      <figcaption className="text-xs text-text-2">
        {t("changes.width", { width })} · {themeLabel(theme)}
      </figcaption>
      {img.data ? (
        <img src={img.data.data_url} alt={alt} loading="lazy" className="h-auto w-full rounded-control border border-border" />
      ) : img.isError ? (
        <p className="text-sm text-text-2">{t("changes.imageMissing")}</p>
      ) : (
        <Loading rows={1} label="loading.file" onRetry={() => void img.refetch()} />
      )}
    </figure>
  );
}

/** The screenshot review's findings, then what it could not check. */
function ScreenshotReview({ review }: { review: ItemScreenshotReview | null }) {
  if (review === null) return <EmptyState title={t("changes.noReview")} />;
  if (!finished(review.status)) return <Notice>{t("changes.reviewWaiting")}</Notice>;
  if (review.status !== "succeeded") return <Notice tone="warn">{t("changes.reviewFailed")}</Notice>;
  return (
    <div data-screenshot-review className="flex flex-col gap-4 text-sm">
      {review.findings.length === 0 ? <p>{t("changes.noFindings")}</p> : (
        <CardSection title={t("changes.findings")} count={review.findings.length}>
          <ul data-raw className="list-disc pl-6 break-words">{review.findings.map((f, i) => <li key={i}>{f.text}</li>)}</ul>
        </CardSection>
      )}
      {review.unverified.length > 0 && (
        <CardSection title={t("changes.unverified")} count={review.unverified.length}>
          <ul data-raw data-screenshot-unverified className="list-disc pl-6 break-words">{review.unverified.map((u, i) => <li key={i}>{u}</li>)}</ul>
        </CardSection>
      )}
      {review.summary && <p data-raw className="text-text-2">{review.summary}</p>}
    </div>
  );
}
