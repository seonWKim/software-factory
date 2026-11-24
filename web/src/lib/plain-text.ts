// Text a calendar wrote, made safe to show (design 09-dashboard-tasks-calendar, event details): markup becomes plain
// text and never reaches the page as HTML (no innerHTML anywhere), and http(s) addresses in it become link parts the
// page draws as <a> elements. Pure; no DOM parser, so nothing in the text is ever loaded or run.

const ENTITIES: Readonly<Record<string, string>> = { nbsp: " ", lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" };

/** `&lt;`, `&#39;`, `&#x27;` and the like as their characters; `&amp;` last, so `&amp;lt;` stays `&lt;`. */
function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

const HTTP = /^https?:\/\//i;

/**
 * `text` with its markup turned into plain text: script and style blocks dropped, line breaks and block ends as new
 * lines, a list item as "• ", a link as its label, a colon and its http(s) address (the address alone when
 * it is the label), every other tag removed, entities decoded, and runs of blank lines cut to one.
 */
export function plainText(text: string): string {
  if (!/[<&]/.test(text)) return text.trim();
  const s = text
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a\s*>/gi, (_, dq?: string, sq?: string, inner = "") => {
      const href = decode(dq ?? sq ?? "").trim();
      const label = inner.replace(/<[^>]*>/g, "").trim();
      if (!HTTP.test(href)) return label;
      return label === "" || decode(label) === href ? href : `${label}: ${href}`;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n• ")
    .replace(/<\/(p|div|li|ul|ol|h[1-6]|tr|blockquote)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "");
  return decode(s).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** A run of plain text, or an http(s) address to draw as a link. */
export type TextPart = { text: string } | { url: string };

/** `text` cut into text and http(s) address parts; a trailing `.`, `,`, `;`, `:`, `!`, `?` or `)` stays text. */
export function linkParts(text: string): TextPart[] {
  const out: TextPart[] = [];
  let last = 0;
  for (const m of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    let url = m[0];
    while (/[.,;:!?)\]]$/.test(url) && !(url.endsWith(")") && url.includes("("))) url = url.slice(0, -1);
    const at = m.index ?? 0;
    if (at > last) out.push({ text: text.slice(last, at) });
    out.push({ url });
    last = at + url.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}
