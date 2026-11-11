import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const WEB_SRC = join(ROOT, "web", "src");
const generate = () => execFileSync("node", [join(ROOT, "scripts", "build-tokens.mjs"), "--stdout"], { encoding: "utf8" });

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
  );
}

describe("design tokens", () => {
  it("web/src/tokens.css is the generator's output, and the output is stable", () => {
    const out = generate();
    expect(out).toBe(generate());
    expect(readFileSync(join(WEB_SRC, "tokens.css"), "utf8")).toBe(out);
    expect(out).toContain("scripts/build-tokens.mjs");
    expect(out).toMatch(/Do not edit/);
  });

  it("holds light values on :root and dark values under .dark", () => {
    const css = readFileSync(join(WEB_SRC, "tokens.css"), "utf8");
    expect(css).toMatch(/:root \{[^}]*--surface:/);
    expect(css).toMatch(/\.dark \{[^}]*--surface:/);
    expect(css).toMatch(/\.dark \{[^}]*--pill-bad-bg:/);
  });

  it("index.css imports the tokens and maps the Tailwind names", () => {
    const css = readFileSync(join(WEB_SRC, "index.css"), "utf8");
    expect(css).toContain('@import "./tokens.css"');
    for (const name of ["--color-border:", "--color-surface:", "--color-text-2:", "--color-accent:", "--radius-card:"]) {
      expect(css).toContain(name);
    }
    expect(css).toContain("prefers-reduced-motion: reduce");
  });

  it("no file under web/src except tokens.css holds a hex colour", () => {
    // Six or eight digits always; three or four only with a letter a-f, so "#192" is not flagged.
    const hex = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|(?=[0-9]*[a-fA-F])[0-9a-fA-F]{3,4})\b/;
    const hits = files(WEB_SRC)
      .filter((f) => !f.endsWith("tokens.css") && /\.(css|tsx?|html|svg)$/.test(f))
      .filter((f) => hex.test(readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });

  it("no file under web/src holds a Tailwind palette colour class", () => {
    const names = "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
    // utility-(palette)-shade, also after dark:/hover:/focus-visible: prefixes, and the bare white/black colours.
    const use = "text|bg|border|ring|outline|divide|fill|stroke|from|via|to|decoration|accent|caret|shadow|placeholder|marker";
    // A CSS variable reference such as bg-(--color-red-700) is not a palette class and is not matched.
    const palette = new RegExp(`(?<![\\w-])(?:${use})-(?:${names})-\\d{2,3}\\b|(?<![\\w-])(?:${use})-(?:white|black)\\b`);
    const hits = files(WEB_SRC)
      .filter((f) => !f.endsWith("tokens.css") && /\.(css|tsx?)$/.test(f))
      .filter((f) => palette.test(readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
    expect(palette.test("dark:hover:bg-zinc-800")).toBe(true);
    expect(palette.test("text-blue-700")).toBe(true);
    expect(palette.test("bg-white")).toBe(true);
    expect(palette.test("bg-surface text-text-2 border-border")).toBe(false);
  });

  it("no file under web/src uses a default radius or an arbitrary type size", () => {
    const bad = /(?<![\w-])rounded(?:-(?:sm|md|lg|xl|2xl|3xl|full))?(?![\w-])|(?<![\w-])text-\[/;
    const hits = files(WEB_SRC)
      .filter((f) => /\.tsx?$/.test(f))
      .filter((f) => bad.test(readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });
});

describe("the Gongbang mark in the dashboard", () => {
  const svg = readFileSync(join(ROOT, "design-system", "icon.svg"), "utf8");

  it("web/public/favicon.png is the 16 px render of design-system/icon.svg, and index.html links it", async () => {
    const icons = (await import(pathToFileURL(join(ROOT, "scripts", "build-icons.mjs")).href as string)) as {
      parseSvg: (text: string) => unknown;
      render: (svg: unknown, size: number) => Buffer;
      decodePng: (png: Buffer) => { width: number; height: number; rgba: Buffer };
    };
    const favicon = icons.decodePng(readFileSync(join(ROOT, "web", "public", "favicon.png")));
    expect([favicon.width, favicon.height]).toEqual([16, 16]);
    expect(favicon.rgba.equals(icons.render(icons.parseSvg(svg), 16))).toBe(true);
    const html = readFileSync(join(ROOT, "web", "index.html"), "utf8");
    expect(html).toMatch(/<link rel="icon" type="image\/png" sizes="16x16" href="\/favicon\.png" \/>/);
    expect(html).toContain("<title>Gongbang</title>");
  });

  it("the sidebar mark draws icon.svg's square and 공", () => {
    // Read as text: this suite is type-checked without JSX.
    const brand = readFileSync(join(WEB_SRC, "components", "ui", "brand.tsx"), "utf8");
    const square = /MARK_SQUARE = \{ x: (\d+), y: (\d+), size: (\d+), rx: (\d+) \}/.exec(brand)!;
    expect(svg).toContain(`<rect id="square" x="${square[1]}" y="${square[2]}" width="${square[3]}" height="${square[3]}" rx="${square[4]}"`);
    const glyph = /MARK_GLYPH =\s*"([^"]+)"/.exec(brand)!;
    expect(svg).toContain(` d="${glyph[1]}"`);
  });
});
