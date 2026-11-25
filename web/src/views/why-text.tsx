import type { Why } from "../api.js";
import { t } from "../i18n/index.js";
import { LINK_CLASS } from "../components/ui/link-style.js";
import { whyText } from "../lib/format.js";
import { Link } from "../nav.js";
import { itemPath } from "../pages.js";

/** `#N` not part of `owner/name#N`, as the server reads refs (src/ui/why.ts). */
const REF = /(?<![\w./-])#(\d+)\b/g;

const PATH = String.raw`[\w@~-]+(?:\.[\w@~-]+)*(?:\/[\w@~-]+(?:\.[\w@~-]+)*)*`;
/** `/retry +paths <path>...` in a why text: the reply that allows those paths and retries. */
const ALLOW = new RegExp(String.raw`\/retry \+paths (?<paths>${PATH}(?: ${PATH})*)`, "g");
/** What the why text names besides `#N`: an item ID, a path. */
const TOKEN = new RegExp(String.raw`(?<id>\bwi_[0-9a-z]+\b)|(?<path>(?<![\w./@:~-])[\w@~-]+(?:\/[\w@~.-]*[\w@~-])+(?![\w#]))`, "g");

/** A path is shown in code style when it has a file extension or at least two slashes (so "and/or" stays text). */
const isPath = (s: string): boolean => s.split("/").length > 2 || /\.\w+$/.test(s);
const basename = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

/** The "Allow <file> and retry" entries a why text offers: one per `/retry +paths ...` it names, with the note that sends it. */
export function allowEntries(text: string): { label: string; note: string }[] {
  return [...text.matchAll(ALLOW)].map((m) => {
    const paths = m.groups!.paths!;
    return { label: t("why.allow", { file: paths.split(" ").map(basename).join(", ") }), note: `+paths ${paths}` };
  });
}

/**
 * Each `#N` a stretch of why text names (from `refs`) links to that issue when the API gave a `ref_url`; an item ID
 * links to the item page; a path is in code style. The text is never changed.
 */
function linked(text: string, why: Pick<Why, "refs" | "ref_url">, key: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let last = 0;
  const plain = (to: number, from = last) => {
    // `#N` links inside a stretch of plain text.
    let at = from;
    for (const m of text.slice(from, to).matchAll(REF)) {
      const n = Number(m[1]);
      if (!why.ref_url || !why.refs.includes(n)) continue;
      parts.push(text.slice(at, from + m.index));
      parts.push(<a key={`${key}ref${from + m.index}`} href={`${why.ref_url}${n}`} target="_blank" rel="noreferrer" className={LINK_CLASS}>#{n}</a>);
      at = from + m.index + m[0].length;
    }
    parts.push(text.slice(at, to));
  };
  for (const m of text.matchAll(TOKEN)) {
    const g = m.groups!;
    const piece = g.id ?? g.path!;
    if (g.path && !isPath(piece)) continue;
    plain(m.index);
    last = m.index + m[0].length;
    parts.push(g.id
      ? <Link key={`${key}i${m.index}`} href={itemPath(piece)} data-why-item={piece} className={LINK_CLASS}>{piece}</Link>
      : <code key={`${key}p${m.index}`} className="font-mono text-xs">{piece}</code>);
  }
  plain(text.length);
  return parts;
}

/** Stands for the holder's name in the text while WhyText puts its link there. */
const HOLDER = "\u0000";

/**
 * Why an item waits, for people: its reason code's en.ts text (whyText). The holder of a held or deadlocked run is
 * named by its title and links to its item page; `#N`, item IDs and paths link as `linked` says.
 */
export function WhyText({ why }: { why: Why }) {
  const holder = why.holder_id && typeof why.params.holder === "string" && why.params.holder ? why.params.holder : null;
  const [before = "", after = ""] = whyText(why, holder === null ? undefined : HOLDER).split(HOLDER);
  return (
    <span data-why={why.code}>
      {linked(before, why, "a")}
      {holder !== null && (
        <>
          <Link href={itemPath(why.holder_id!)} data-why-holder={why.holder_id} className={LINK_CLASS}>{holder}</Link>
          {linked(after, why, "b")}
        </>
      )}
    </span>
  );
}
