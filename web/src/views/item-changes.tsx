import { useApi } from "../api/client.js";
import { Card, CardSection } from "../components/ui/card.js";
import { EmptyState, Notice } from "../components/ui/notice.js";
import { Loading } from "../components/ui/parts.js";
import { t } from "../i18n/index.js";
import { SCREENSHOT_SIZES, SCREENSHOT_THEMES } from "../../../src/shared/screenshots.js";

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
          <EmptyState title={t("changes.noScreenshots")} description={t("changes.noScreenshotsHint")} />
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
        <Loading rows={1} />
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
