import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Every English text the web app shows comes from web/src/i18n/en.ts (read with t()). This scans the .tsx files
// outside web/src/i18n for English words in JSX text and in aria-label, title and placeholder attributes.

const WEB = join(import.meta.dirname, "..", "web", "src");
const ATTRIBUTES = new Set(["aria-label", "title", "placeholder"]);
const WORD = /[A-Za-z]{2,}/;

/** The English texts in one .tsx source: JSX text, and the three attributes with a literal value. */
function englishTexts(source: string): string[] {
  const file = ts.createSourceFile("sample.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node) && WORD.test(node.text)) found.push(node.text.trim());
    if (ts.isJsxAttribute(node) && ATTRIBUTES.has(node.name.getText(file)) && node.initializer && ts.isStringLiteral(node.initializer) && WORD.test(node.initializer.text)) {
      found.push(node.initializer.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return e.name === "i18n" ? [] : tsxFiles(path);
    return e.name.endsWith(".tsx") ? [path] : [];
  });
}

describe("web text", () => {
  it("flags English JSX text and literal aria-label, title and placeholder in a planted sample", () => {
    const sample = `export const A = () => <div title="Close it"><p>Hello there</p><input placeholder="Type" aria-label="Search box" /></div>;`;
    expect(englishTexts(sample)).toEqual(["Close it", "Hello there", "Type", "Search box"]);
  });

  it("accepts text read through the catalog", () => {
    const sample = `export const A = () => <div title={t("a.b")}><p>{t("a.c")}</p> · 12</div>;`;
    expect(englishTexts(sample)).toEqual([]);
  });

  it("finds no English text outside the catalog in any file of web/src", () => {
    const dirty = tsxFiles(WEB)
      .filter((f) => englishTexts(readFileSync(f, "utf8")).length > 0)
      .map((f) => relative(join(WEB, "..", ".."), f).split("\\").join("/"))
      .sort();
    expect(dirty).toEqual([]);
  });
});
