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
    for (const name of ["--color-border:", "--color-surface:", "--color-text-2:", "--color-accent:", "--color-failed:", "--color-on-solid:", "--radius-card:"]) {
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

  it("no raw button, select, textarea or input element appears under web/src outside components/ui", () => {
    // A JSX tag opens with `<name` and whitespace, `>` or `/`, so a tag spread over several lines is caught too.
    const raw = /<(?:button|select|textarea|input)(?=[\s/>])/;
    const ui = join(WEB_SRC, "components", "ui");
    const hits = files(WEB_SRC)
      .filter((f) => /\.tsx?$/.test(f) && !f.startsWith(ui))
      .filter((f) => raw.test(readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
    // Self-check: a multi-line raw tag and a radio are caught; the components and words in text are not.
    expect(raw.test('<button\n  type="button"\n  onClick={go}\n>')).toBe(true);
    expect(raw.test('<input type="radio" name="r" />')).toBe(true);
    expect(raw.test("<select>")).toBe(true);
    expect(raw.test('<Button variant="ghost" /> <Select /> <Textarea /> <Input /> <Radio />')).toBe(false);
    expect(raw.test("<buttons> and <inputs>")).toBe(false);
  });

  it("components/ui has the control set, and every control shares the focus ring and the disabled look", () => {
    const ui = (name: string) => readFileSync(join(WEB_SRC, "components", "ui", name), "utf8");
    const control = ui("control.ts");
    expect(control).toMatch(/focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-focus/);
    expect(control).toMatch(/outline-none/);
    expect(control).toMatch(/disabled:cursor-not-allowed disabled:opacity-50/);
    const button = ui("button.tsx");
    for (const v of ["primary:", "secondary:", "ghost:", "danger:"]) expect(button).toContain(v);
    expect(button).toMatch(/md: "min-h-8 px-3 text-sm"/);
    expect(button).toMatch(/sm: "min-h-7 px-2 text-xs"/);
    expect(button).toMatch(/icon: "size-8/);
    // Hover only on an enabled button, so a disabled one keeps its border and text colours.
    expect(button).not.toMatch(/(?<![\w:-])hover:/);
    for (const [file, name] of [["select.tsx", "Select"], ["input.tsx", "Input"], ["textarea.tsx", "Textarea"], ["radio.tsx", "Radio"], ["field.tsx", "Field"], ["button-row.tsx", "ButtonRow"]] as const) {
      expect(ui(file)).toContain(`export function ${name}(`);
    }
    for (const file of ["button.tsx", "select.tsx", "input.tsx", "textarea.tsx", "radio.tsx"]) expect(ui(file)).toMatch(/\b(FOCUS|FIELD)\b/);
    expect(ui("select.tsx")).toMatch(/h-8 [^"]*appearance-none[^"]*pr-8 pl-3/);
    expect(ui("input.tsx")).toContain("h-8 min-w-0 px-3");
    expect(ui("textarea.tsx")).toContain("px-3 py-2");
    expect(ui("button-row.tsx")).toContain("flex flex-wrap items-center gap-2");
    expect(ui("field.tsx")).toContain("flex-col gap-1");
    const dialog = ui("dialog.tsx");
    expect(dialog).not.toMatch(/\bconst (BUTTON|DANGER)\b/);
    expect(dialog).toMatch(/rounded-card/);
    expect(dialog).toMatch(/\bp-6\b/);
    expect(dialog).toMatch(/<ButtonRow className="justify-end">/);
  });

  it("no file under web/src uses a default radius or an arbitrary type size", () => {
    const bad = /(?<![\w-])rounded(?:-(?:sm|md|lg|xl|2xl|3xl|full))?(?![\w-])|(?<![\w-])text-\[/;
    const hits = files(WEB_SRC)
      .filter((f) => /\.tsx?$/.test(f))
      .filter((f) => bad.test(readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });
});

describe("contrast", () => {
  const css = readFileSync(join(WEB_SRC, "tokens.css"), "utf8");
  const block = (name: string) => new RegExp(`${name} \\{([^}]*)\\}`).exec(css)![1]!;
  const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lum = (hex: string) => {
    const [r, g, b] = rgb(hex).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a: string, b: string) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);

  for (const [theme, selector] of [["light", ":root"], ["dark", "\\.dark"]] as const) {
    it(`meets 4.5:1 in ${theme}`, () => {
      const root = block(":root");
      const t = (name: string) => {
        const m = new RegExp(`--${name}: (#[0-9A-Fa-f]{6});`).exec(theme === "light" ? root : block(selector) + root);
        return m![1]!;
      };
      const pairs: [string, string][] = [];
      for (const fg of ["text", "text-2", "text-3"]) for (const bg of ["bg", "surface", "surface-2", "sidebar"]) pairs.push([fg, bg]);
      for (const fg of ["accent", "running", "done", "failed"]) pairs.push([fg, "surface"]);
      for (const s of ["ok", "warn", "bad", "info"]) pairs.push([`pill-${s}-fg`, `pill-${s}-bg`]);
      // Text on a filled accent or failed background (a primary button, a destructive confirm).
      for (const bg of ["accent", "failed"]) pairs.push(["on-solid", bg]);
      for (const [fg, bg] of pairs) expect(ratio(t(fg), t(bg)), `${theme} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    });
  }

  it("the type scale has a size and a line height per step", () => {
    for (const step of ["xs", "sm", "base", "lg", "xl"]) {
      expect(css).toMatch(new RegExp(`--fs-${step}: [\\d.]+rem;`));
      expect(css).toMatch(new RegExp(`--lh-${step}: [\\d.]+rem;`));
    }
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

  it("icon.svg's ember dot has the ember token's colour, is drawn at every size, and the sidebar draws it", () => {
    const tokens = JSON.parse(readFileSync(join(ROOT, "design-system", "tokens.json"), "utf8")) as { colors: Record<string, Record<string, string>> };
    const hex = /<circle id="ember"[^>]* fill="(#[0-9A-Fa-f]{6})"/.exec(svg)![1]!;
    expect(hex.toUpperCase()).toBe(tokens.colors.light!.ember!.toUpperCase());
    expect(hex.toUpperCase()).toBe(tokens.colors.dark!.ember!.toUpperCase());
    expect(svg).not.toContain("data-min-px");
    const css = readFileSync(join(WEB_SRC, "tokens.css"), "utf8");
    expect(css).toMatch(/:root \{[^}]*--ember: #FB923C;/);
    expect(css).toMatch(/\.dark \{[^}]*--ember: #FB923C;/);
    expect(readFileSync(join(WEB_SRC, "index.css"), "utf8")).toContain("--color-ember: var(--ember);");
    expect(readFileSync(join(WEB_SRC, "components", "ui", "brand.tsx"), "utf8")).toContain("fill-ember");
  });

  it("the sidebar mark draws icon.svg's square and 공", () => {
    // Read as text: this suite is type-checked without JSX.
    const brand = readFileSync(join(WEB_SRC, "components", "ui", "brand.tsx"), "utf8");
    const square = /MARK_SQUARE = \{ x: (\d+), y: (\d+), size: (\d+), rx: (\d+) \}/.exec(brand)!;
    expect(svg).toContain(`<rect id="square" x="${square[1]}" y="${square[2]}" width="${square[3]}" height="${square[3]}" rx="${square[4]}"`);
    const glyph = /MARK_GLYPH =\s*"([^"]+)"/.exec(brand)!;
    expect(svg).toContain(` d="${glyph[1]}"`);
  });

  it("the dialog, the row menu panel and the toast use token utilities only: no zinc-, red- or rounded-md", () => {
    const dialog = readFileSync(join(WEB_SRC, "components", "ui", "dialog.tsx"), "utf8");
    // The row's "⋯" menu is the shared OverflowMenu.
    const overflow = readFileSync(join(WEB_SRC, "components", "ui", "menu.tsx"), "utf8");
    const toast = dialog.match(/const STATUS_CLASS =\s*"([^"]*)"/)?.[1];
    const menu = overflow.match(/role="menu"[^>]*?className="([^"]*)"/)?.[1];
    expect(toast).toContain("bg-surface");
    expect(menu).toContain("bg-surface");
    const bad = /(?<![\w-])(?:[a-z-]+-)?(?:zinc|red)-\d|(?<![\w-])rounded-md(?![\w-])/;
    for (const [name, text] of [["dialog.tsx", dialog], ["the menu panel", menu!], ["the toast", toast!]] as const) expect(bad.test(text), name).toBe(false);
    expect(bad.test("bg-zinc-900 dark:border-red-500 rounded-md")).toBe(true);
    expect(dialog).toContain("rounded-card");
    expect(dialog).toContain("border-border-strong");
  });

  it("the item page has no inline approve confirm or inline verdict form: every action opens the shared Dialog", () => {
    const commands = readFileSync(join(WEB_SRC, "views", "item-commands.tsx"), "utf8");
    const decisions = readFileSync(join(WEB_SRC, "views", "item-decisions.tsx"), "utf8");
    expect(commands).not.toMatch(/ApproveConfirm|VERDICT_PLACEHOLDER|setConfirming/);
    expect(decisions).not.toMatch(/ApproveConfirm/);
    for (const name of ["ApproveDialog", "RejectDialog", "ReviseDialog", "VerdictDialog"]) expect(commands + decisions).toContain(`function ${name}(`);
  });
});
