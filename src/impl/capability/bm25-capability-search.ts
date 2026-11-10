import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import type { Capability, CapabilitySearch } from "../../interfaces/capability-search.js";

/**
 * BM25 over the repo's markdown docs and skills (design §7, progressive disclosure). Agents get a short
 * index (path, name, snippet) and Read the full text themselves. Finding a doc grants no permission.
 *
 * What is indexed: `*.md` files under `docs/` and `skills/` below the code root, and under each extra skill
 * folder (a pack's `skills/`, design 11-packs.md; kind `skill`, ID its absolute path). Directories named
 * `prompts` or `node_modules`, dot-directories, dot-files and symlinks are skipped, so nothing outside
 * those roots is ever read.
 *
 * The index is a per-process cache rebuilt from files: built at construction, and rebuilt by `search()`
 * whenever an indexed file's mtime or size changes or a file is added or removed. Nothing is shared
 * between replicas.
 */

/** Roots searched below the code root. */
export const INDEX_ROOTS = ["docs", "skills"] as const;
/** Directory names never descended into (dot-directories are skipped too). */
const SKIP_DIRS = new Set(["prompts", "node_modules"]);

/** BM25 parameters (the usual defaults). */
const K1 = 1.2;
const B = 0.75;
/**
 * Fixed field boost: a term in the name or a heading counts as HEADING_BOOST occurrences, a term in the
 * rest of the body as one. So a heading-only match outranks the same term in body text only.
 */
export const HEADING_BOOST = 3;
/** The snippet (Capability.summary) is at most this many characters, ending in "…" when cut. */
export const SNIPPET_MAX = 200;

export interface IndexedDoc {
  /** Repo-relative path with `/` separators. */
  id: string;
  kind: "doc" | "skill";
  /** First `#` heading, else the file name without `.md`. */
  name: string;
  /** Every other heading, in order. */
  headings: string[];
  /** First paragraph after the title, collapsed to one line (uncapped). */
  firstParagraph: string;
  /** The whole file. */
  body: string;
}

interface Scored {
  doc: IndexedDoc;
  /** Weighted term frequencies: heading terms × HEADING_BOOST + body terms. */
  tf: Map<string, number>;
  length: number;
}

export class Bm25CapabilitySearch implements CapabilitySearch {
  private signature = "";
  private docs: Scored[] = [];
  private df = new Map<string, number>();
  private avgLength = 0;

  constructor(
    private readonly codeRoot: string,
    private readonly skillDirs: readonly string[] = [],
  ) {
    this.refresh();
  }

  async search(query: string, limit: number): Promise<Capability[]> {
    this.refresh();
    const terms = [...new Set(tokenize(query))];
    if (terms.length === 0 || limit <= 0 || this.docs.length === 0) return [];
    const n = this.docs.length;
    const results: { doc: IndexedDoc; score: number }[] = [];
    for (const d of this.docs) {
      let score = 0;
      for (const t of terms) {
        const f = d.tf.get(t);
        if (!f) continue;
        const df = this.df.get(t) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        score += (idf * f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.length) / (this.avgLength || 1)));
      }
      if (score > 0) results.push({ doc: d.doc, score });
    }
    results.sort((a, b) => b.score - a.score || (a.doc.id < b.doc.id ? -1 : 1));
    return results.slice(0, limit).map(({ doc }) => ({ id: doc.id, kind: doc.kind, name: doc.name, summary: snippet(doc.firstParagraph) }));
  }

  /** The indexed entries, for tests and diagnostics. */
  entries(): readonly IndexedDoc[] {
    this.refresh();
    return this.docs.map((d) => d.doc);
  }

  /** Rebuilds when the set of files, or any file's mtime or size, differs from the last build. */
  private refresh(): void {
    const files = listFiles(this.codeRoot, this.skillDirs);
    const signature = files.map((f) => `${f.id}\0${f.mtimeMs}\0${f.size}`).join("\n");
    if (signature === this.signature) return;
    const docs: Scored[] = [];
    for (const f of files) {
      let text: string;
      try {
        text = readFileSync(f.path, "utf8");
      } catch {
        continue; // removed between listing and reading; the next search sees the new state
      }
      docs.push(score(...parse(f.id, f.kind, text)));
    }
    const df = new Map<string, number>();
    for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    this.docs = docs;
    this.df = df;
    this.avgLength = docs.length ? docs.reduce((s, d) => s + d.length, 0) / docs.length : 0;
    this.signature = signature;
  }
}

/** Lowercased runs of ASCII letters and digits. */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/** One line, at most SNIPPET_MAX characters; a cut one ends in "…". */
export function snippet(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= SNIPPET_MAX ? line : `${line.slice(0, SNIPPET_MAX - 1)}…`;
}

interface FileInfo {
  id: string;
  kind: IndexedDoc["kind"];
  path: string;
  mtimeMs: number;
  size: number;
}

function listFiles(codeRoot: string, skillDirs: readonly string[]): FileInfo[] {
  const out: FileInfo[] = [];
  const walk = (dir: string, idOf: (path: string) => string, kind: IndexedDoc["kind"]) => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const path = join(dir, name);
      let st;
      try {
        st = lstatSync(path);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name)) walk(path, idOf, kind);
      } else if (st.isFile() && name.endsWith(".md")) {
        out.push({ id: idOf(path), kind, path, mtimeMs: st.mtimeMs, size: st.size });
      }
    }
  };
  const fromCodeRoot = (path: string) => relative(codeRoot, path).split(sep).join("/");
  const roots = [
    ...INDEX_ROOTS.map((root) => ({ path: join(codeRoot, root), idOf: fromCodeRoot, kind: root === "skills" ? "skill" as const : "doc" as const })),
    ...skillDirs.map((path) => ({ path, idOf: (p: string) => p, kind: "skill" as const })),
  ];
  for (const root of roots) {
    try {
      const st = lstatSync(root.path);
      if (st.isDirectory() && !st.isSymbolicLink()) walk(root.path, root.idOf, root.kind);
    } catch {
      // root absent: nothing to index there
    }
  }
  return out;
}

/** A skill file as a capability: its name and snippet as the search lists them (design 11-packs.md, list-all). */
export function skillCapability(id: string, text: string): Capability {
  const [doc] = parse(id, "skill", text);
  return { id, kind: "skill", name: doc.name, summary: snippet(doc.firstParagraph) };
}

/** The entry, plus the text of every non-heading line (the body terms). */
function parse(id: string, kind: IndexedDoc["kind"], text: string): [IndexedDoc, string] {
  const lines = text.split(/\r?\n/);
  let name: string | null = null;
  let titleLine = -1;
  const headings: string[] = [];
  const isHeading: boolean[] = [];
  let fenced = false;
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const m = fenced ? null : /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    isHeading[i] = m !== null;
    if (!m) return;
    if (name === null && m[1] === "#") {
      name = m[2]!;
      titleLine = i;
    } else headings.push(m[2]!);
  });

  // First paragraph after the title (or from the top when there is no title): the first run of
  // non-blank, non-heading lines outside a code fence.
  const para: string[] = [];
  fenced = false;
  for (let i = titleLine + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*(```|~~~)/.test(line)) {
      if (para.length) break;
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (line.trim() === "" || isHeading[i]) {
      if (para.length) break;
      continue;
    }
    para.push(line.trim());
  }

  const doc: IndexedDoc = {
    id,
    kind,
    name: name ?? basename(id, ".md"),
    headings,
    firstParagraph: para.join(" ").replace(/\s+/g, " ").trim(),
    body: text,
  };
  return [doc, lines.filter((_, i) => !isHeading[i]).join("\n")];
}

function score(doc: IndexedDoc, plain: string): Scored {
  const tf = new Map<string, number>();
  let length = 0;
  const add = (tokens: string[], weight: number) => {
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + weight);
    length += tokens.length * weight;
  };
  add(tokenize([doc.name, ...doc.headings].join(" ")), HEADING_BOOST);
  // Body terms: every line that is not a heading (headings were counted above, boosted).
  add(tokenize(plain), 1);
  return { doc, tf, length };
}
