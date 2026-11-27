import type { ReactNode } from "react";
import type { ItemDetail } from "../api.js";
import type { ThreadEntry } from "../api/item-commands.js";
import { StatusBadge } from "../components/ui/badge.js";
import { LINK_CLASS } from "../components/ui/link-style.js";
import { type MessageKey, en } from "../i18n/en.js";
import { t } from "../i18n/index.js";
import { isHttpUrl, isWorkerId, shortItemId, termLabel, tokens, workerName } from "../lib/format.js";
import { stateLabel } from "../../../src/shared/states.js";
import { SourceLink, When } from "./common.js";

// The item page's status and facts (design 09-dashboard-item): the closed status line, the facts grid, and the
// timeline's sentences, which the closed line reuses for what closed the item.

type Item = ItemDetail["item"];
type TimelineEntry = ItemDetail["timeline"][number];

/** The item page's Timeline card: the closed line's fallback link goes here. */
export const TIMELINE_ANCHOR = "timeline";

/** The timeline's actor as a phrase: "you" for the viewer, "the factory", "worker 2", else "a person" (never a name). */
function actorPhrase(actor: TimelineEntry["actor"], viewer: string | null): string {
  const id = actor.kind === "system" ? null : actor.id;
  if (!id || id === "system") return t("person.factory");
  if (isWorkerId(id)) return workerName(id);
  return id === viewer ? t("person.you") : t("person.other");
}

/** One timeline row's sentence ("You asked for a retry"); "Changed" for a reason with no sentence. */
export function timelineSentence(entry: TimelineEntry, viewer: string | null): string {
  const key = `timeline.${entry.reason}`;
  if (!entry.reason || !(key in en)) return t("item.change");
  const whom = actorPhrase(entry.actor, viewer);
  return t(key as MessageKey, { who: whom.charAt(0).toLocaleUpperCase() + whom.slice(1), whom });
}

/** The newest timeline entry that moved the item to Closed; null when the timeline has none (an old item). */
function closingEntry(timeline: readonly TimelineEntry[]): TimelineEntry | null {
  const closes = timeline.filter((e) => e.changes.stage?.to?.includes("CLOSED"));
  return closes.reduce<TimelineEntry | null>((a, c) => (a && a.version > c.version ? a : c), null);
}

const lowerFirst = (s: string) => s.charAt(0).toLocaleLowerCase() + s.slice(1);

/**
 * A closed item's one status line, in place of the open item's reason and its "no command" sentence: "Closed — you
 * rejected the plan · 2d ago" (what closed it, from the closing timeline entry's sentence, else the close reason), and
 * the reason one click away: the owner's newest message in the thread up to the close, else the Timeline card.
 */
export function ClosedStatus({ item, timeline, thread, now, viewer }: { item: Item; timeline: readonly TimelineEntry[]; thread: readonly ThreadEntry[]; now: number; viewer: string | null }) {
  const closing = closingEntry(timeline);
  const sentence = closing?.reason && `timeline.${closing.reason}` in en ? timelineSentence(closing, viewer) : null;
  const what = sentence ?? (item.close_reason ? termLabel(item.close_reason) : stateLabel(item.item_phase));
  const at = closing?.at ?? item.updated_at;
  const said = thread.filter((m) => m.role === "owner" && Date.parse(m.at) <= Date.parse(at) + 60_000).at(-1);
  return (
    <p data-closed-status className="text-sm text-pretty">
      <span className="font-medium">{t("item.closedLine", { what: lowerFirst(what) })}</span>
      <span className="text-text-2"> · <When at={at} now={now} /> · </span>
      <a href={`#${said ? said.anchor : TIMELINE_ANCHOR}`} className={LINK_CLASS}>{said ? t("item.closedWhy") : t("item.closedHistory")}</a>
    </p>
  );
}

/** A link when the URL is http(s); the text alone otherwise (a withheld marker, a local path, anything else). */
function UrlOrText({ url, text }: { url: string | null | undefined; text: string }) {
  if (isHttpUrl(url)) return <a href={url} target="_blank" rel="noreferrer" className={LINK_CLASS}>{text}</a>;
  return <span>{url && url !== text ? `${text} (${url})` : text}</span>;
}

/**
 * The item's facts: state, source, tier, PR, plan, review loops, restarts, tokens, updated. Every item, open or closed,
 * shows only the facts with a value: no "–" for a tier, PR or plan it never had, no review loops, restarts or tokens
 * it never took. One column, in the page's right rail.
 * The IDs stay in the IDs disclosure below.
 */
export function ItemFacts({ item, now }: { item: Item; now: number }) {
  const level = item.item_phase;
  const facts: [string, ReactNode, boolean][] = [
    [t("col.state"), <StatusBadge state={level}>{stateLabel(level)}{level === "closed" && item.close_reason ? ` (${termLabel(item.close_reason)})` : ""}</StatusBadge>, true],
    [t("item.source"), isHttpUrl(item.source.link) ? <SourceLink source={item.source} className="inline-block align-bottom" /> : shortItemId(item.id), true],
    [t("item.tier"), item.tier ?? "–", item.tier !== null],
    [t("col.pr"), item.change_ref === null ? "–" : <UrlOrText url={item.change_url} text={`#${item.change_ref}`} />, item.change_ref !== null],
    [t("item.specComment"), item.spec_comment_url ? <UrlOrText url={item.spec_comment_url} text={t("item.specCommentLink")} /> : "–", !!item.spec_comment_url],
    [t("item.reviewLoops"), item.loop_count, item.loop_count > 0],
    [t("item.restarts"), item.restart_count, item.restart_count > 0],
    [termLabel("token_cost"), tokens(item.token_cost), item.token_cost > 0],
    [t("item.updated"), <When at={item.updated_at} now={now} />, true],
  ];
  const shown = facts.filter(([, , has]) => has);
  return (
    <dl data-item-facts className="grid grid-cols-1 gap-y-1 text-sm">
      {shown.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="text-xs text-text-2">{k}</dt>
          <dd className="truncate tabular-nums">{typeof v === "object" ? v : String(v)}</dd>
        </div>
      ))}
    </dl>
  );
}
