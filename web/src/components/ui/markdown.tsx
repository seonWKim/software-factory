import type { ReactNode } from "react";
import { isHttpUrl } from "../../lib/format.js";
import { LINK_CLASS } from "./link-style.js";

// A small markdown renderer for spec text (design §9): headings, paragraphs, lists, fenced code, inline code,
// bold and links. It builds React elements only, never HTML strings, so raw HTML in the text shows as text. A
// link is drawn only for an http(s) URL; any other link (javascript:, data:, relative) shows its text, plain.

const INLINE = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    out.push(text.slice(last, m.index));
    const key = m.index;
    if (m[1] !== undefined) out.push(<code key={key} className="rounded bg-zinc-100 px-1 font-mono text-xs dark:bg-zinc-800">{m[1]}</code>);
    else if (m[2] !== undefined) out.push(<strong key={key}>{m[2]}</strong>);
    else if (isHttpUrl(m[4])) out.push(<a key={key} href={m[4]} target="_blank" rel="noreferrer" className={LINK_CLASS}>{m[3]}</a>);
    else out.push(m[3]);
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "p"; text: string }
  | { kind: "ul" | "ol"; items: string[] }
  | { kind: "code"; text: string };

const HEADING = /^(#{1,6})\s+(.*)$/;
const UL = /^\s*[-*+]\s+(.*)$/;
const OL = /^\s*\d+[.)]\s+(.*)$/;

function blocks(text: string): Block[] {
  const out: Block[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    if (line.trimStart().startsWith("```")) {
      const code: string[] = [];
      while (++i < lines.length && !lines[i]!.trimStart().startsWith("```")) code.push(lines[i]!);
      out.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      out.push({ kind: "heading", level: h[1]!.length, text: h[2]! });
      continue;
    }
    const list = UL.test(line) ? UL : OL.test(line) ? OL : null;
    if (list) {
      const items: string[] = [];
      for (; i < lines.length && list.test(lines[i]!); i++) items.push(list.exec(lines[i]!)![1]!);
      i--;
      out.push({ kind: list === UL ? "ul" : "ol", items });
      continue;
    }
    const para: string[] = [];
    for (; i < lines.length && lines[i]!.trim() !== "" && !HEADING.test(lines[i]!) && !UL.test(lines[i]!) && !OL.test(lines[i]!) && !lines[i]!.trimStart().startsWith("```"); i++) {
      para.push(lines[i]!.trim());
    }
    i--;
    out.push({ kind: "p", text: para.join(" ") });
  }
  return out;
}

const HEADING_TAG = ["h3", "h4", "h5", "h6", "h6", "h6"] as const;

export function Markdown({ text }: { text: string }) {
  return (
    <div data-markdown className="space-y-2 text-sm text-pretty break-words">
      {blocks(text).map((b, n) => {
        switch (b.kind) {
          case "heading": {
            const Tag = HEADING_TAG[b.level - 1]!;
            return <Tag key={n} className="font-semibold">{inline(b.text)}</Tag>;
          }
          case "p":
            return <p key={n}>{inline(b.text)}</p>;
          case "ul":
          case "ol": {
            const Tag = b.kind;
            return (
              <Tag key={n} className={b.kind === "ul" ? "list-disc pl-5" : "list-decimal pl-5"}>
                {b.items.map((it, k) => <li key={k}>{inline(it)}</li>)}
              </Tag>
            );
          }
          case "code":
            return <pre key={n} className="overflow-x-auto rounded bg-zinc-100 p-2 font-mono text-xs dark:bg-zinc-900"><code>{b.text}</code></pre>;
        }
      })}
    </div>
  );
}
