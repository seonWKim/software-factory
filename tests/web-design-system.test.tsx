// @vitest-environment jsdom
// @ts-nocheck -- same reason as tests/data-page.test.tsx: tsconfig.test.json has no DOM and no JSX.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// The Design system page (web/src/views/design.tsx) shows every component exported from web/src/components/ui/.

const WEB = join(import.meta.dirname, "..", "web", "src");
const UI = join(WEB, "components", "ui");
const GALLERY = join(WEB, "views", "design.tsx");

const parse = (path: string) => ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const PASCAL = /^[A-Z][a-z][A-Za-z0-9]*$/;

/** The exported components of one source: PascalCase functions and consts (types and interfaces are not components). */
function exportedComponents(source: ts.SourceFile): string[] {
  const names: string[] = [];
  for (const st of source.statements) {
    const exported = ts.canHaveModifiers(st) && ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) continue;
    if (ts.isFunctionDeclaration(st) && st.name) names.push(st.name.text);
    if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) names.push(d.name.text);
  }
  return names.filter((n) => PASCAL.test(n));
}

/** The tag names used as JSX in one source. */
function jsxTags(source: ts.SourceFile): Set<string> {
  const tags = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) tags.add(node.tagName.getText(source));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return tags;
}

const uiComponents = () => readdirSync(UI).filter((f) => f.endsWith(".ts") || f.endsWith(".tsx")).flatMap((f) => exportedComponents(parse(join(UI, f))));

describe("the Design system gallery", () => {
  it("uses every exported component of components/ui as a JSX tag", () => {
    const used = jsxTags(parse(GALLERY));
    const missing = uiComponents().filter((name) => !used.has(name));
    expect(missing).toEqual([]);
  });

  it("finds the components it should, and reports one that is left out", () => {
    const names = uiComponents();
    expect(names).toEqual(expect.arrayContaining(["Button", "DataTable", "StatusBadge", "Dialog", "Select"]));
    const source = ts.createSourceFile("x.tsx", "export function Ghost() { return null; }\nexport interface Props {}\nexport const SIZE = 1;", ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    expect(exportedComponents(source)).toEqual(["Ghost"]);
    expect(jsxTags(ts.createSourceFile("y.tsx", "const a = <Button><Input /></Button>;", ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX))).toEqual(new Set(["Button", "Input"]));
  });

  it("imports no API, query or store module and holds no hex colour", () => {
    const source = readFileSync(GALLERY, "utf8");
    const imports = [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    expect(imports.filter((m) => /api|query|store|nav\.js|keys/.test(m))).toEqual([]);
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
