import type { MergeCheckView } from "../api.js";
import { mergeCheckLabel } from "../api.js";
import { t } from "../i18n/index.js";
import { cn } from "../lib/cn.js";
import { ID_CLASS, LINK_CLASS } from "../components/ui/link-style.js";
import { isHttpUrl, shortSource } from "../lib/format.js";
import { Link } from "../nav.js";
import { itemPath } from "../pages.js";

/**
 * The item's source id in short form (`#192`, `30331a68`), linked to the source; the full id shows on hover. With
 * `itemId`, a source with no web address (a local item's `local:` link) links to the item's page instead.
 */
export function SourceLink({ source, className, itemId }: { source: { id: string; link: string }; className?: string; itemId?: string }) {
  if (itemId !== undefined && !isHttpUrl(source.link)) {
    return (
      <Link href={itemPath(itemId)} title={source.id} className={cn("max-w-[16ch] min-w-0 truncate tabular-nums", ID_CLASS, className)}>
        {shortSource(source.id)}
      </Link>
    );
  }
  return (
    <a href={source.link} target="_blank" rel="noreferrer" title={source.id} className={cn("max-w-[16ch] min-w-0 truncate tabular-nums", ID_CLASS, className)}>
      {shortSource(source.id)}
    </a>
  );
}

/** An item's title linking to its page, wrapping at any width; "Untitled item" when it has none. */
export function ItemTitle({ id, title }: { id: string; title: string | null }) {
  return (
    <Link href={itemPath(id)} data-raw={title !== null ? "" : undefined} className={cn("max-w-full font-medium break-words", LINK_CLASS)}>
      {title ?? t("item.untitled")}
    </Link>
  );
}

/** A ready-to-merge item's merge check label; the conflicting file names show on hover. */
export function MergeCheckNote({ check }: { check: MergeCheckView }) {
  const tone = check.state === "conflicts" ? "text-pill-bad-fg" : check.state === "mergeable" ? "text-pill-ok-fg" : "text-text-2";
  return (
    <span data-merge-check={check.state} className={cn("ml-2 text-xs whitespace-nowrap", tone)} {...(check.conflicts.length > 0 ? { title: check.conflicts.join("\n") } : {})}>
      {mergeCheckLabel(check)}
    </span>
  );
}

/** An item's PR as "PR #N": a link out when it has a stored link, plain text otherwise. */
export function PrLink({ number, url, className }: { number: string; url: string | null; className?: string }) {
  const text = t("tree.pr", { ref: number });
  return url ? <a href={url} target="_blank" rel="noreferrer" className={cn(LINK_CLASS, className)}>{text}</a> : <span className={className}>{text}</span>;
}
