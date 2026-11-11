import type { ReactNode } from "react";
import { isHttpUrl } from "../../lib/format.js";
import { LINK_CLASS } from "./link-style.js";

// A small markdown renderer for spec text (design §9): headings, paragraphs, lists, fenced code, inline code,
// bold, links and a `<details><summary>…</summary>` fold on lines of their own. It builds React elements only,
// never HTML strings, so any other raw HTML in the text shows as text. A link is drawn only for an http(s) URL;
// any other link (javascript:, data:, relative) shows its text, plain.

const INLINE = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    out.push(text.slice(last, m.index));
    const key = m.index;
    if (m[1] !== undefined) out.push(<code key={key} className="rounded-control bg-surface-2 px-1 py-0.5 font-mono text-xs">{m[1]}</code>);
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
  | { kind: "code"; text: string }
  | { kind: "details"; summary: string; body: Block[] };

const HEADING = /^(#{1,6})\s+(.*)$/;
const UL = /^\s*[-*+]\s+(.*)$/;
const OL = /^\s*\d+[.)]\s+(.*)$/;
const DETAILS = /^\s*<details>\s*<summary>(.*)<\/summary>\s*$/;
const DETAILS_END = /^\s*<\/details>\s*$/;

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
    const d = DETAILS.exec(line);
    if (d) {
      const inner: string[] = [];
      while (++i < lines.length && !DETAILS_END.test(lines[i]!)) inner.push(lines[i]!);
      out.push({ kind: "details", summary: d[1]!, body: blocks(inner.join("\n")) });
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
    for (; i < lines.length && lines[i]!.trim() !== "" && !HEADING.test(lines[i]!) && !UL.test(lines[i]!) && !OL.test(lines[i]!) && !lines[i]!.trimStart().startsWith("```") && !DETAILS.test(lines[i]!); i++) {
      para.push(lines[i]!.trim());
    }
    i--;
    out.push({ kind: "p", text: para.join(" ") });
  }
  return out;
}

const HEADING_TAG = ["h3", "h4", "h5", "h6", "h6", "h6"] as const;
const HEADING_SIZE = ["text-base", "text-base", "text-sm", "text-sm", "text-sm", "text-sm"] as const;

// Sections a reader should not miss get a tinted block (heading through to the next heading of its level or
// higher): the plain summary first, the questions for the owner as needing attention.
type Tone = "summary" | "attention";
const CALLOUTS: readonly [RegExp, Tone][] = [
  [/^in short\b/i, "summary"],
  [/^decisions for you\b/i, "attention"],
];
const TONE_CLASS: Record<Tone, string> = {
  summary: "border-accent bg-pill-info-bg",
  attention: "border-pill-warn-fg bg-pill-warn-bg",
};

// "AS-IS: … TO-BE: …" in one paragraph shows as two lines, each label in bold.
const AS_IS_TO_BE = /^AS-IS:\s*(.*?)\s*(?:→\s*)?TO-BE:\s*(.*)$/s;
const LABEL = /^(AS-IS|TO-BE):\s*(.*)$/s;

function Paragraph({ text }: { text: string }) {
  const both = AS_IS_TO_BE.exec(text);
  const lines = both ? [`AS-IS: ${both[1]}`, `TO-BE: ${both[2]}`] : [text];
  return lines.map((line, k) => {
    const l = LABEL.exec(line);
    return <p key={k}>{l ? <><strong>{l[1]}:</strong> {inline(l[2]!)}</> : inline(line)}</p>;
  });
}

function renderBlock(b: Block, n: number): ReactNode {
  switch (b.kind) {
    case "heading": {
      const Tag = HEADING_TAG[b.level - 1]!;
      const rule = b.level <= 2 ? "border-b border-border pb-1" : "";
      return <Tag key={n} className={`${HEADING_SIZE[b.level - 1]} ${rule} font-semibold text-balance text-text-1 not-first:mt-5`}>{inline(b.text)}</Tag>;
    }
    case "p":
      return <Paragraph key={n} text={b.text} />;
    case "ul":
    case "ol": {
      const Tag = b.kind;
      return (
        <Tag key={n} className={`${b.kind === "ul" ? "list-disc" : "list-decimal"} space-y-1 pl-5 marker:text-text-3`}>
          {b.items.map((it, k) => <li key={k} className="pl-1">{inline(it)}</li>)}
        </Tag>
      );
    }
    case "code":
      return <pre key={n} className="overflow-x-auto rounded-control bg-surface-2 p-3 font-mono text-xs leading-normal"><code>{b.text}</code></pre>;
    case "details":
      return (
        <details key={n} className="rounded-control border border-border px-3 py-2">
          <summary className="cursor-pointer font-medium text-text-1">{inline(b.summary)}</summary>
          <div className="mt-2 space-y-3">{renderBlocks(b.body)}</div>
        </details>
      );
  }
}

function renderBlocks(list: Block[]): ReactNode[] {
  const out: ReactNode[] = [];
  for (let i = 0; i < list.length; i++) {
    const b = list[i]!;
    const tone = b.kind === "heading" ? CALLOUTS.find(([re]) => re.test(b.text))?.[1] : undefined;
    if (b.kind !== "heading" || !tone) {
      out.push(renderBlock(b, i));
      continue;
    }
    const start = i;
    while (i + 1 < list.length && !(list[i + 1]!.kind === "heading" && (list[i + 1] as { level: number }).level <= b.level)) i++;
    out.push(
      <div key={start} data-callout={tone} className={`space-y-2 rounded-r-control border-l-4 px-3 py-2 not-first:mt-5 ${TONE_CLASS[tone]}`}>
        {list.slice(start, i + 1).map((x, k) => renderBlock(x, start + k))}
      </div>,
    );
  }
  return out;
}

export function Markdown({ text }: { text: string }) {
  return (
    <div data-markdown className="space-y-3 text-sm leading-relaxed text-pretty break-words">
      {renderBlocks(blocks(text))}
    </div>
  );
}
