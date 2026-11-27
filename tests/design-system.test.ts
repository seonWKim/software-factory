import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { BACKGROUND_JOBS } from "../src/controller/background-jobs.js";
import { SCHEDULE_ACTION_KINDS, type ScheduleActionKind } from "../src/core/schedule.js";
import { ACTOR_WORDS } from "../src/ui/activity-api.js";
import { PAGES } from "../web/src/pages.js";

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

  it("index.css maps every type step to text-<step> and both shadows to shadow-sm and shadow-lg", () => {
    const css = readFileSync(join(WEB_SRC, "index.css"), "utf8");
    for (const step of ["xs", "sm", "base", "lg", "xl"]) {
      expect(css).toContain(`--text-${step}: var(--fs-${step});`);
      expect(css).toContain(`--text-${step}--line-height: var(--lh-${step});`);
    }
    for (const size of ["sm", "lg"]) expect(css).toContain(`--shadow-${size}: var(--sh-${size});`);
    const tokens = readFileSync(join(WEB_SRC, "tokens.css"), "utf8");
    expect(tokens).toMatch(/:root \{[^}]*--sh-sm: [^;]+;[^}]*--sh-lg: [^;]+;/);
    expect(tokens).toMatch(/\.dark \{[^}]*--sh-sm: [^;]+;[^}]*--sh-lg: [^;]+;/);
  });

  it("tokens.json names the type roles, and PageHeader and Card draw their titles in them", () => {
    const json = JSON.parse(readFileSync(join(ROOT, "design-system", "tokens.json"), "utf8")) as { "type-roles": Record<string, { step: string; weight: string }> };
    const roles = json["type-roles"];
    expect(roles["page-title"]).toEqual({ step: "xl", weight: "semibold" });
    expect(roles["section-title"]).toEqual({ step: "base", weight: "semibold" });
    expect(roles.body).toEqual({ step: "sm", weight: "normal" });
    expect(roles.meta).toEqual({ step: "xs", weight: "normal" });
    const ui = (name: string) => readFileSync(join(WEB_SRC, "components", "ui", name), "utf8");
    expect(ui("notice.tsx")).toMatch(/<h1 className="[^"]*\btext-xl font-semibold\b/);
    expect(ui("card.tsx")).toMatch(/CARD_TITLE = "[^"]*\btext-base font-semibold"/);
  });

  it("a Disclosure summary is text-2 by default, and the update toast on the surface keeps it (no pill fill under it)", () => {
    expect(readFileSync(join(WEB_SRC, "components", "ui", "disclosure.tsx"), "utf8")).toMatch(/summaryTone = "text-text-2"/);
    expect(readFileSync(join(WEB_SRC, "components", "ui", "toast.tsx"), "utf8")).toMatch(/\bbg-surface\b/);
    const banner = readFileSync(join(WEB_SRC, "views", "system-banner.tsx"), "utf8");
    const note = banner.slice(banner.indexOf("export function UpdateNote"), banner.indexOf("export function FactoryRevision"));
    expect(note).toMatch(/<Toast\b/);
    expect(note).not.toMatch(/bg-pill-/);
    expect(note).toMatch(/<Disclosure summary=/);
  });

  it("tokens.json holds the two page widths, tokens.css declares them and index.css maps them to max-w-page-*", () => {
    const json = JSON.parse(readFileSync(join(ROOT, "design-system", "tokens.json"), "utf8")) as { page: Record<string, string> };
    expect(json.page).toEqual({ wide: "77rem", read: "60rem" });
    expect(readFileSync(join(WEB_SRC, "tokens.css"), "utf8")).toMatch(/:root \{[^}]*--page-wide: 77rem;[^}]*--page-read: 60rem;/);
    const css = readFileSync(join(WEB_SRC, "index.css"), "utf8");
    expect(css).toContain("--container-page-wide: var(--page-wide);");
    expect(css).toContain("--container-page-read: var(--page-read);");
  });

  it("main takes its width from PageHeader's width prop, and no page sets its own page width", () => {
    const app = readFileSync(join(WEB_SRC, "App.tsx"), "utf8");
    expect(app).toMatch(/<main className="[^"]*\bmax-w-page-wide has-\[\[data-page-width=read\]\]:max-w-page-read\b/);
    const header = readFileSync(join(WEB_SRC, "components", "ui", "notice.tsx"), "utf8");
    expect(header).toMatch(/width = "wide"/);
    expect(header).toMatch(/data-page-width=\{width\}/);
    // A page-level width: max-w-2xl and up, a screen width or a page token. Field widths (max-w-md, max-w-xl, max-w-[75ch]) stay.
    const page = /(?<![\w-])max-w-(?:[2-7]xl|screen|page-|\(--page)/;
    const hits = files(join(WEB_SRC, "views")).filter((f) => /\.tsx?$/.test(f) && page.test(readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
    expect(page.test('className="max-w-3xl space-y-4"')).toBe(true);
    expect(page.test('className="max-w-md max-w-xl max-w-[75ch]"')).toBe(false);
  });

  it("About prose is capped at 75ch in TEXT", () => {
    const about = readFileSync(join(WEB_SRC, "views", "item-about.tsx"), "utf8");
    expect(about).toMatch(/const TEXT = "[^"]*\bmax-w-\[75ch\]/);
  });

  it("every h2 in the views is in Card's title type and every h3 in the one sub-group type", () => {
    const card = readFileSync(join(WEB_SRC, "components", "ui", "card.tsx"), "utf8");
    expect(card).toMatch(/SUB_TITLE = "text-xs font-medium text-text-2"/);
    expect(card).toMatch(/<Heading[^>]*className=\{Heading === "h2" \? CARD_TITLE : SUB_TITLE\}/);
    const bad = [...files(join(WEB_SRC, "views")), ...files(join(WEB_SRC, "components", "ui"))]
      .filter((f) => f.endsWith(".tsx"))
      .flatMap((f) => [...readFileSync(f, "utf8").matchAll(/<(h2|h3)\b[^>]*>/g)].filter((m) => !m[0].includes(m[1] === "h2" ? "CARD_TITLE" : "SUB_TITLE")).map((m) => `${f}: ${m[0]}`));
    expect(bad).toEqual([]);
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

  it('no role="checkbox" appears under web/src outside components/ui: a checkbox is the shared Checkbox', () => {
    const raw = /role=(?:"checkbox"|'checkbox'|\{["']checkbox["']\})/;
    const ui = join(WEB_SRC, "components", "ui");
    const hits = files(WEB_SRC)
      .filter((f) => /\.tsx?$/.test(f) && !f.startsWith(ui))
      .filter((f) => raw.test(readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
    // Self-check: a raw role="checkbox" is caught; the component and other roles are not.
    expect(raw.test('<Button role="checkbox" aria-checked />')).toBe(true);
    expect(raw.test("<div role={'checkbox'} />")).toBe(true);
    expect(raw.test('<Checkbox aria-label="x" /> <Button role="switch" />')).toBe(false);
  });

  it("no raw table element appears under web/src/views: tables are the shared Table, Tr and Td", () => {
    const raw = /<(?:table|thead|tbody|tfoot|tr|td|th|caption)(?=[\s/>])/;
    const hits = files(join(WEB_SRC, "views"))
      .filter((f) => /\.tsx?$/.test(f))
      .filter((f) => raw.test(readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
    // Self-check: a multi-line raw td and a th are caught; the components and words such as <thread> are not.
    expect(raw.test('<td\n  data-day={d}\n  className="p-1"\n>')).toBe(true);
    expect(raw.test('<th scope="col">')).toBe(true);
    expect(raw.test("<table>")).toBe(true);
    expect(raw.test("<Table /> <Tr> <Td /> <thread> <title> <tdx>")).toBe(false);
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
    for (const [file, name] of [["select.tsx", "Select"], ["input.tsx", "Input"], ["textarea.tsx", "Textarea"], ["radio.tsx", "Radio"], ["checkbox.tsx", "Checkbox"], ["field.tsx", "Field"], ["button-row.tsx", "ButtonRow"]] as const) {
      expect(ui(file)).toContain(`export function ${name}(`);
    }
    for (const file of ["button.tsx", "select.tsx", "input.tsx", "textarea.tsx", "radio.tsx"]) expect(ui(file)).toMatch(/\b(FOCUS|FIELD)\b/);
    // Select: a 32px field with its own list in the menu's look, and the shared focus ring and disabled look on its options.
    const select = ui("select.tsx");
    expect(select).toMatch(/h-8 [^"]*pr-8 pl-3/);
    expect(select).not.toMatch(/<select(?=[\s/>])/);
    expect(select).toMatch(/role="listbox"/);
    expect(select).toMatch(/"absolute [^"]*rounded-control border border-border bg-surface py-1 shadow"/);
    expect(select).toMatch(/role="option"/);
    expect(select).toMatch(/"[^"]*text-sm enabled:hover:bg-surface-2"/);
    expect(select).toMatch(/FOCUS,\s*"focus-visible:-outline-offset-2",\s*DISABLED,/);
    expect(ui("input.tsx")).toContain("h-8 min-w-0 px-3");
    expect(ui("textarea.tsx")).toContain("px-3 py-2");
    expect(ui("button-row.tsx")).toContain("flex flex-wrap items-center gap-2");
    expect(ui("field.tsx")).toContain("flex-col gap-1");
    const dialog = ui("dialog.tsx");
    expect(dialog).not.toMatch(/\bconst (BUTTON|DANGER)\b/);
    expect(dialog).toMatch(/rounded-card/);
    // space-6 around the content: the title, the scrolling body and the footer each carry their side of it.
    expect(dialog).toMatch(/\bpx-6 pt-6\b/);
    expect(dialog).toMatch(/<ButtonRow data-dialog-footer className="shrink-0 justify-end px-6 pb-6">/);
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

  // Badge's tones, read as text (this suite is type-checked without JSX): each `bg-X text-Y` pair as token names.
  const badgeTones = (): [string, string][] => {
    const src = readFileSync(join(WEB_SRC, "components", "ui", "badge.tsx"), "utf8");
    const token = (cls: string) => (cls === "text-1" ? "text" : cls);
    return [...src.matchAll(/"bg-([\w-]+) text-([\w-]+)"/g)].map((m) => [token(m[1]!), token(m[2]!)]);
  };

  it("reads every Badge tone, the neutral one included", () => {
    const tones = badgeTones();
    for (const s of ["ok", "warn", "bad", "info"]) expect(tones).toContainEqual([`pill-${s}-bg`, `pill-${s}-fg`]);
    expect(tones).toContainEqual(["surface-2", "text"]);
  });

  for (const [theme, selector] of [["light", ":root"], ["dark", "\\.dark"]] as const) {
    it(`meets 4.5:1 in ${theme}, text and pill-*-fg on each pill-{ok,warn,bad,info}-bg included`, () => {
      const root = block(":root");
      const t = (name: string) => {
        const m = new RegExp(`--${name}: (#[0-9A-Fa-f]{6});`).exec(theme === "light" ? root : block(selector) + root);
        return m![1]!;
      };
      const pairs: [string, string][] = [];
      for (const fg of ["text", "text-2", "text-3"]) for (const bg of ["bg", "surface", "surface-2", "sidebar"]) pairs.push([fg, bg]);
      for (const fg of ["accent", "running", "done", "failed"]) pairs.push([fg, "surface"]);
      for (const fg of ["accent", "running", "done", "failed"]) pairs.push([fg, "bg"]);
      // A pill's text on its own fill, and on a card or the page (an inline error or warning line).
      for (const s of ["ok", "warn", "bad", "info"]) for (const bg of [`pill-${s}-bg`, "surface", "bg"]) pairs.push([`pill-${s}-fg`, bg]);
      // The text a panel on a pill fill may use: its own fg (above) or text-1; never text-2 or text-3.
      for (const s of ["ok", "warn", "bad", "info"]) pairs.push(["text", `pill-${s}-bg`]);
      // Every tone Badge and StatusBadge draw (TONE_CLASS, the neutral one included): its text token on its fill token.
      for (const [bg, fg] of badgeTones()) pairs.push([fg, bg]);
      // Text on a filled accent or failed background (a primary button, a destructive confirm).
      for (const bg of ["accent", "failed"]) pairs.push(["on-solid", bg]);
      for (const [fg, bg] of pairs) expect(ratio(t(fg), t(bg)), `${theme} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    });
  }

  for (const [theme, selector] of [["light", ":root"], ["dark", "\\.dark"]] as const) {
    it(`the current-page bar (nav-active) meets 3:1 on the sidebar in ${theme}`, () => {
      const t = (name: string) => new RegExp(`--${name}: (#[0-9A-Fa-f]{6});`).exec(theme === "light" ? block(":root") : block(selector) + block(":root"))![1]!;
      expect(ratio(t("nav-active"), t("sidebar")), `${theme} nav-active on sidebar`).toBeGreaterThanOrEqual(3);
    });
  }

  for (const [theme, selector] of [["light", ":root"], ["dark", "\\.dark"]] as const) {
    it(`the current-page fill (sidebar-active) is at least 1.1:1 from the sidebar in ${theme}`, () => {
      const t = (name: string) => new RegExp(`--${name}: (#[0-9A-Fa-f]{6});`).exec(theme === "light" ? block(":root") : block(selector) + block(":root"))![1]!;
      expect(ratio(t("sidebar-active"), t("sidebar")), `${theme} sidebar-active on sidebar`).toBeGreaterThanOrEqual(1.1);
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
    expect(css).toMatch(/:root \{[^}]*--ember: #F2A55F;/);
    expect(css).toMatch(/\.dark \{[^}]*--ember: #F2A55F;/);
    expect(readFileSync(join(WEB_SRC, "index.css"), "utf8")).toContain("--color-ember: var(--ember);");
    expect(readFileSync(join(WEB_SRC, "components", "ui", "brand.tsx"), "utf8")).toContain("fill-ember");
  });

  it("the sidebar mark draws icon.svg's square and glyph", () => {
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
    const menu = overflow.match(/export const MENU_PANEL = "([^"]*)"/)?.[1];
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

  it("maps every token of tokens.css in index.css @theme inline, and sidebar links use FOCUS", () => {
    const tokens = [...new Set([...readFileSync(join(WEB_SRC, "tokens.css"), "utf8").matchAll(/^\s+(--[\w-]+):/gm)].map((m) => m[1]!))];
    const unmapped = (css: string) => tokens.filter((n) => !css.includes(`var(${n})`));
    const css = readFileSync(join(WEB_SRC, "index.css"), "utf8");
    expect(unmapped(css)).toEqual([]);
    // Self-check: a missing mapping is caught.
    expect(unmapped(css.replace("var(--sidebar)", ""))).toEqual(["--sidebar"]);
    const sidebar = readFileSync(join(WEB_SRC, "shell", "sidebar.tsx"), "utf8");
    const focus = readFileSync(join(WEB_SRC, "components", "ui", "control.ts"), "utf8").match(/export const FOCUS =\s*"([^"]+)"/)![1]!;
    expect(sidebar).toMatch(/LINK_ROW = `[^`]*\$\{FOCUS\}`/);
    expect(focus).toContain("focus-visible:outline-focus");
  });
});

/**
 * Inner spacing in web/src/views that design-system/patterns.md:15 does not cover: a margin between parts inside one
 * block (a label and its field, a note under a table), not between the blocks of a page. A line is allowed when it is
 * in `file` and contains `snippet`; each entry gives its reason.
 */
const INNER_SPACING: readonly { file: string; snippet: string; reason: string }[] = [
  { file: "project-files.tsx", snippet: "font-mono break-all", reason: "folder path above its table, inside a Card" },
  { file: "settings/advanced.tsx", snippet: 'data-group="developers"', reason: "collapsed table under the keys table, inside a Card" },
  { file: "settings/advanced.tsx", snippet: "data-project-label", reason: "form above the keys table, inside a Card" },
  { file: "spend.tsx", snippet: "mb-3 flex flex-wrap", reason: "toolbar row above a table, inside a Card" },
  { file: "spend.tsx", snippet: "spend.tasksCapped", reason: "note above a table, inside a Card" },
  { file: "spend.tsx", snippet: "data-spend-notes", reason: "notes under a table, inside a Card" },
  { file: "rules.tsx", snippet: "mt-3 space-y-6", reason: "the opened Disclosure's body" },
  { file: "rules.tsx", snippet: "data-how-promoting", reason: "help disclosure under the waiting lists, inside a Card" },
  { file: "decision-card.tsx", snippet: "mb-3 block w-full", reason: "note field above the buttons, inside the decision card" },
  { file: "item-about.tsx", snippet: "data-about-part", reason: "a labelled part of the spec, inside the About Card" },
  { file: "item-about.tsx", snippet: "data-about-checks", reason: "checks under the request, inside the About Card" },
  { file: "item-about.tsx", snippet: "data-about-spec", reason: "spec disclosure under the request and checks, inside the About Card" },
  { file: "plugins.tsx", snippet: "data-tab-head", reason: "Import and Add above the table, inside a Card" },
  { file: "plugins-evals.tsx", snippet: "mb-4 flex flex-wrap", reason: "suite row above the cases table, inside a Card" },
  { file: "plugins-evals.tsx", snippet: "evals.cannotWrite", reason: "note under the cases table, inside a Card" },
  { file: "item-decisions.tsx", snippet: "data-decisions", reason: "list above the buttons, inside a block" },
  { file: "workers.tsx", snippet: "workers.legend", reason: "legend under the graph, inside one Card" },
  { file: "workers.tsx", snippet: "data-timeline-scroll", reason: "timeline table under the legend, inside one Card" },
  { file: "workers.tsx", snippet: "data-alone", reason: "note under the graph, inside one Card" },
  { file: "transcript.tsx", snippet: "data-run-outcome", reason: "outcome box under the run's header, inside a Card" },
  { file: "transcript.tsx", snippet: "data-load-more", reason: "load-more button under the steps list, inside a Card" },
  { file: "schedules/detail.tsx", snippet: "data-schedule-suggestions", reason: "suggestions under their field" },
  { file: "item-commands.tsx", snippet: "data-queued-feedback", reason: "feedback under the command row" },
  { file: "data.tsx", snippet: "data-ask-answer", reason: "answer under the question box, inside a Card" },
  { file: "task-work.tsx", snippet: "tasks.heldUntil", reason: "note above a table, inside a Card" },
  { file: "command-box.tsx", snippet: "command.proposals", reason: "proposals under the box's input" },
  { file: "command-box.tsx", snippet: "data-proposal-actions", reason: "buttons under the proposals list" },
  // Phase 1 of widening the guard to N >= 1: margins of 1 and 2 in the item, data, decision and small view files.
  { file: "calendar-grid.tsx", snippet: 'wrap && "mt-1"', reason: "colour dot nudged down to the first line of a wrapped title, inside a calendar cell" },
  { file: "data.tsx", snippet: 'className="mb-2 flex flex-wrap items-center gap-2"', reason: "row above the table's content, inside a Card" },
  { file: "data.tsx", snippet: 'className="mb-2 space-y-1 text-sm" data-testid="data-table-info"', reason: "table description above the rows, inside a Card" },
  { file: "data.tsx", snippet: "max-sm:mb-1", reason: "meaning under its term on a phone, inside the table description list" },
  { file: "data.tsx", snippet: 'className="mt-1 overflow-x-auto', reason: "SQL box under the question's heading, inside a Card" },
  { file: "decision-card.tsx", snippet: 'className="mt-1 flex flex-wrap gap-x-3 gap-y-1"', reason: "list under its label, inside the decision card" },
  { file: "decision-card.tsx", snippet: 'cn("mb-1", CARD_TITLE)', reason: "card title above the card's body, inside the decision card" },
  { file: "decision-card.tsx", snippet: "data-commands-off", reason: "notice above the buttons, inside the decision card" },
  { file: "decision-card.tsx", snippet: "data-commands-actor", reason: "notice above the buttons, inside the decision card" },
  { file: "decision-card.tsx", snippet: 'className="mt-2 flex flex-col items-start gap-1"', reason: "extra buttons under the main row, inside the decision card" },
  { file: "failures.tsx", snippet: "failures-cap", reason: "cap note above the table, inside a Card" },
  { file: "item-about.tsx", snippet: 'cn("mb-1", SUB_TITLE)', reason: "sub-heading above the checks list, inside the About Card" },
  { file: "item-attachments.tsx", snippet: "data-add-context", reason: "add-context form under its trigger, inside the Attachments Card" },
  { file: "item-attachments.tsx", snippet: 'aria-label={t("attach.kind")} className="mt-1', reason: "radio group under its label, inside the add-context form" },
  { file: "item-changes.tsx", snippet: "item.pickFile", reason: "hint under the file list, inside the Changes Card" },
  { file: "item-changes.tsx", snippet: 'className="mt-2 space-y-1"', reason: "list under the diff header, inside the Changes Card" },
  { file: "item-checks.tsx", snippet: "data-check-output", reason: "output disclosure under the check's row, inside the Checks Card" },
  { file: "item-checks.tsx", snippet: 'className="mt-1 max-h-64', reason: "output box inside the opened disclosure, inside the Checks Card" },
  { file: "item-commands.tsx", snippet: 'className="mt-1 space-y-1"', reason: "list under its heading, inside the commands Card" },
  { file: "item-commands.tsx", snippet: 'ref={wrap} className="mt-2"', reason: "menu under the item's header, inside the commands Card" },
  { file: "item-commands.tsx", snippet: "data-commands-none", reason: "note under the menu trigger, inside the commands Card" },
  { file: "item-commands.tsx", snippet: "data-item-menu", reason: "button row under the menu's note, inside the commands Card" },
  { file: "item-commands.tsx", snippet: 'aria-label={t("commands.verdict")}', reason: "radio group under its label, inside the verdict form" },
  { file: "item-commands.tsx", snippet: 'className="mt-1 flex flex-col gap-1"', reason: "list under its label, inside the commands Card" },
  { file: "item-decisions.tsx", snippet: 'aria-label={label} className="mt-1', reason: "radio group under its question, inside the decisions block" },
  { file: "item-decisions.tsx", snippet: 'className="mt-1 w-full"', reason: "answer field under its question, inside the decisions block" },
  { file: "item-decisions.tsx", snippet: "data-confirm-answers", reason: "answers list under the confirm text, inside the decisions block" },
  { file: "item-decisions.tsx", snippet: 'aria-label={t("decisions.reason")}', reason: "radio group under its label, inside the decisions block" },
  { file: "item-row.tsx", snippet: "data-row-second", reason: "second line under the row's title, inside one row" },
  { file: "merge-button.tsx", snippet: 'className="mt-2 inline-flex', reason: "confirm buttons under the merge button, inside its block" },
  // Phase 2 of widening the guard to N >= 1: margins of 1 and 2 in the pages, efficiency, transcript and settings views.
  { file: "pages.tsx", snippet: 'aria-label={t("item.breadcrumb")} className="mb-1', reason: "breadcrumb above the item's title, inside the page header" },
  { file: "pages.tsx", snippet: 'data-testid="parent" className="mt-1', reason: "parent line under the item's title, inside the page header" },
  { file: "pages.tsx", snippet: "data-ids className=\"mt-2\"", reason: "ids disclosure under the header text, inside one Card" },
  { file: "pages.tsx", snippet: 'className="mt-1 grid grid-cols-[auto_minmax(0,1fr)]', reason: "ids list inside its opened disclosure" },
  { file: "pages.tsx", snippet: 'aria-label={t("item.conflicting")}', reason: "list under its label, inside one Card" },
  { file: "pages.tsx", snippet: "r.error.detail", reason: "error detail under the error's message, inside one Card" },
  { file: "pages.tsx", snippet: '<RawDetails className="mt-1">', reason: "raw details under their row, inside one Card (two lines)" },
  { file: "pages.tsx", snippet: 'ul className="mt-1 font-mono text-xs break-all"', reason: "list inside the opened raw details" },
  { file: "pages.tsx", snippet: '<div className="mt-1">', reason: "block under its heading, inside one Card" },
  { file: "pages.tsx", snippet: "data-spec className=\"mt-2", reason: "spec fields under their toggle, inside one Card" },
  { file: "pages.tsx", snippet: 'cn("mb-1", SUB_TITLE)', reason: "field name above its value, inside the spec box" },
  { file: "pages.tsx", snippet: 'aria-label={t("runners.runsOf"', reason: "runs list under the runner's row, inside one Card" },
  { file: "pages.tsx", snippet: 'data-testid="ok-checks"', reason: "passing checks disclosure under the open checks, inside one Card" },
  { file: "efficiency.tsx", snippet: 'aria-label={title} className="mt-2', reason: "bars under the chart title, inside a Card" },
  { file: "efficiency.tsx", snippet: "aria-hidden className=\"mt-1 flex justify-between", reason: "axis labels under the bars, inside a Card" },
  { file: "efficiency.tsx", snippet: "data-finished", reason: "finished line above the week's figures, inside a Card" },
  { file: "efficiency.tsx", snippet: "efficiency.notCountedTokens", reason: "note under the figures, inside a Card" },
  { file: "efficiency.tsx", snippet: "efficiency.notCountedTime", reason: "note under the figures, inside a Card" },
  { file: "efficiency.tsx", snippet: 'className="mt-1 block h-2', reason: "meter bar under its label, inside one row" },
  { file: "efficiency.tsx", snippet: "data-left-out", reason: "note under the table, inside a Card" },
  { file: "efficiency.tsx", snippet: "efficiency.runsWithoutUsage", reason: "note under the table, inside a Card" },
  { file: "transcript.tsx", snippet: 'className={cn("mt-1", LINK_CLASS)}', reason: "show-more button under a step's text, inside a Card" },
  { file: "transcript.tsx", snippet: 'cn(PRE, "mt-1', reason: "step text under its header line, inside a Card" },
  { file: "transcript.tsx", snippet: 'className="mb-1 flex flex-wrap items-center gap-2', reason: "step meta line above its text, inside a Card" },
  { file: "transcript.tsx", snippet: 'className="mt-1 text-xs opacity-80', reason: "usage line under the outcome text, inside the outcome box" },
  { file: "transcript.tsx", snippet: "transcript.plainFormat", reason: "note above the steps list, inside a Card" },
  { file: "transcript.tsx", snippet: "transcript.tailNote", reason: "note above the steps list, inside a Card" },
  { file: "transcript.tsx", snippet: 'className="mb-1 text-sm"', reason: "run line above its details, inside a Card" },
  { file: "settings/advanced.tsx", snippet: '<div className="mt-1">{list}</div>', reason: "list under its label, inside a settings row" },
  { file: "settings/advanced.tsx", snippet: "data-duration", reason: "readable duration under its field, inside a settings row" },
  { file: "settings/advanced.tsx", snippet: "data-learned", reason: "learned-rule row under its field, inside a settings row" },
  { file: "settings/advanced.tsx", snippet: 'ul className="mt-1 font-mono break-all"', reason: "list inside the opened learned-rule details" },
  { file: "settings/advanced.tsx", snippet: 'className="mt-2"', reason: "block under its field, inside a settings row" },
  { file: "settings/advanced.tsx", snippet: '<div className="mt-2">', reason: "block under its field, inside a settings row" },
  { file: "settings/advanced.tsx", snippet: "data-model-summary", reason: "summary above the model fields, inside a settings row" },
  { file: "settings/advanced.tsx", snippet: '<p className="mt-1 text-xs text-text-2">', reason: "note under its heading, inside a Card" },
  { file: "settings/advanced.tsx", snippet: "border-t border-border pt-2", reason: "divided block under the note, inside a Card" },
  { file: "settings/advanced.tsx", snippet: '<p className="mb-1 text-xs text-text-2">', reason: "note above its list, inside the divided block" },
  { file: "settings/editor.tsx", snippet: "{form}", reason: "form under its row, inside a settings row" },
  { file: "settings-calendar.tsx", snippet: 'hidden={!open} className="mt-1', reason: "opened help under its toggle, inside a Card" },
  { file: "settings-file-keys.tsx", snippet: 'role="alert" className="mt-1', reason: "error under the field, inside a Card" },
  { file: "settings-file-keys.tsx", snippet: 'role="status" className="mt-1', reason: "status under the field, inside a Card" },
  { file: "settings-file-keys.tsx", snippet: "data-filed", reason: "filed-issue line under the form, inside a Card" },
  { file: "settings-file-keys.tsx", snippet: 'className="mt-1"', reason: "control under its label, inside a Card" },
  { file: "settings-row.tsx", snippet: "max-w-64 text-xs", reason: "hint under its field, inside a settings row" },
  // Phase 3 of widening the guard to N >= 1: margins of 1 and 2 in the rules, plugins, schedules, standing and remaining views.
  { file: "host-sleeps.tsx", snippet: '<RawDetails className="mt-2">', reason: "raw details under the row above it" },
  { file: "plugins.tsx", snippet: 'className="mt-2 text-xs text-pretty break-words text-pill-bad-fg"', reason: "error line under the form's controls" },
  { file: "rules-applied.tsx", snippet: "mt-2 ${STACK_NARROW}", reason: "stacked block under the row above it" },
  { file: "rules-detail.tsx", snippet: '<div className="mt-2 space-y-1">', reason: "list under its heading, inside one block" },
  { file: "rules-improve.tsx", snippet: '<div className="mt-2 space-y-2">', reason: "list under its heading, inside one block" },
  { file: "rules-skills.tsx", snippet: "mb-2 ${PROSE} ${muted}", reason: "note above its list, inside one block" },
  { file: "rules.tsx", snippet: "mb-2 ${PROSE} ${muted}", reason: "note above its list, inside one block" },
  { file: "schedules/detail.tsx", snippet: "mb-2 min-w-0 wrap-anywhere sm:mb-0", reason: "field values in the detail list (two lines)" },
  { file: "spend.tsx", snippet: 'data-axis="x"', reason: "axis labels under the bars, inside one Card" },
  { file: "standing.tsx", snippet: 'className="mt-1 text-xs text-pretty break-words text-pill-bad-fg"', reason: "error line under the controls" },
  { file: "standing.tsx", snippet: "data-recent-all", reason: "list under its heading, inside one block" },
  { file: "standing.tsx", snippet: '<ul className="mt-1 list-disc pl-5">', reason: "list under its heading, inside one block" },
  { file: "standing.tsx", snippet: "mb-2 ${muted}", reason: "note above its content, inside one block" },
  { file: "system-banner.tsx", snippet: 'className="mt-1 max-h-48', reason: "list under the banner's line" },
  { file: "system-banner.tsx", snippet: "update.more", reason: "count note under the list" },
  { file: "tasks.tsx", snippet: '<div className="mt-2">', reason: "block under its heading" },
  { file: "thread.tsx", snippet: 'flush className="mt-2"', reason: "toggle under the thread's header" },
  { file: "tree.tsx", snippet: "group mt-1 text-text-2", reason: "chevron nudged to line up with the row's text" },
  { file: "workers.tsx", snippet: 'className="mt-1 flex justify-between text-xs', reason: "axis labels under the graph" },
];

describe("page blocks are stacked by the page's gap-6 column", () => {
  const views = join(WEB_SRC, "views");
  const MARGIN = /(?<![\w-])m[tb]-(?:(?:[1-9]|[1-9]\d)(?![\w-])|\[)/;
  const flagged = (rel: string, text: string) =>
    text
      .split("\n")
      .map((line, i) => ({ line, at: `web/src/views/${rel}:${i + 1}` }))
      .filter(({ line }) => MARGIN.test(line))
      .filter(({ line }) => !INNER_SPACING.some((a) => a.file === rel && line.includes(a.snippet)))
      .map(({ at, line }) => `${at}: ${line.trim()}`);

  it("no page block carries mt-N or mb-N (N >= 3, or an arbitrary [value]) of its own", () => {
    const found = files(views)
      .filter((f) => f.endsWith(".tsx"))
      .flatMap((f) => flagged(f.slice(views.length + 1), readFileSync(f, "utf8")));
    expect(
      found,
      "design-system/patterns.md:15: blocks of one page are stacked in one flex column with a gap-6, not with mb-* or mt-* on each block. Move these into the page's column, or add inner spacing to INNER_SPACING with its reason.",
    ).toEqual([]);
  });

  it("phase 3 files: every mt-1, mt-2, mb-1 or mb-2 line is listed in INNER_SPACING", () => {
    const SMALL = /(?<![\w-])m[tb]-[12](?![\w.-])/;
    const phase3 = [
      "host-sleeps.tsx", "plugins.tsx", "rules-applied.tsx", "rules-detail.tsx", "rules-improve.tsx", "rules-skills.tsx",
      "rules.tsx", "schedules/detail.tsx", "spend.tsx", "standing.tsx", "system-banner.tsx", "tasks.tsx", "thread.tsx",
      "tree.tsx", "workers.tsx",
    ];
    const unlisted = phase3.flatMap((rel) =>
      readFileSync(join(views, rel), "utf8")
        .split("\n")
        .map((line, i) => ({ line, at: `web/src/views/${rel}:${i + 1}` }))
        .filter(({ line }) => SMALL.test(line))
        .filter(({ line }) => !INNER_SPACING.some((a) => a.file === rel && line.includes(a.snippet)))
        .map(({ at, line }) => `${at}: ${line.trim()}`),
    );
    expect(unlisted).toEqual([]);
  });

  it("self-check: a block margin is flagged, an allowed inner one and scroll-mt are not", () => {
    expect(flagged("pages.tsx", '<div className="mt-6">')).toHaveLength(1);
    expect(flagged("pages.tsx", '<div className="mb-3 flex">')).toHaveLength(1);
    expect(flagged("pages.tsx", '<div className="scroll-mt-4 first:mt-0">')).toEqual([]);
    expect(flagged("spend.tsx", '<div data-spend-notes className="mt-3">')).toEqual([]);
    expect(flagged("item-about.tsx", '<div className="mt-3">')).toHaveLength(1);
    expect(flagged("item-about.tsx", '<div data-about-part className="mt-3 min-w-0">')).toEqual([]);
    expect(flagged("pages.tsx", '<div className="mt-[10px]">')).toHaveLength(1);
    expect(flagged("pages.tsx", '<div className="mb-[2rem] flex">')).toHaveLength(1);
    expect(flagged("pages.tsx", '<div className="mt-2">')).toHaveLength(1);
  });
});

// design-system/patterns.md "Page layout": a status badge sits before the text it judges (design 09-dashboard-item-about).
describe("a done-when row puts its badge before the criterion", () => {
  it("data-check-badge comes before the line text in item-checks.tsx", () => {
    const src = readFileSync(join(WEB_SRC, "views", "item-checks.tsx"), "utf8");
    const badge = src.indexOf("data-check-badge");
    const line = src.indexOf("{shown(row.line)}");
    expect(badge).toBeGreaterThan(-1);
    expect(line).toBeGreaterThan(badge);
  });
});

// design-system/patterns.md "Autonomous work is visible": the page where each schedule action kind (a persona is a
// feedback schedule, the daily improve run an improve one) shows what it does and its runs.
const AUTONOMOUS_SURFACES: Record<ScheduleActionKind, string> = {
  build: "schedules",
  agent: "schedules",
  feedback: "schedules",
  improve: "schedules",
  check_page: "schedules",
  summary: "schedules",
};

describe("autonomous work is visible", () => {
  it("every schedule action kind has a page in AUTONOMOUS_SURFACES, and the Schedules page names it and says what it does", () => {
    expect(Object.keys(AUTONOMOUS_SURFACES).sort()).toEqual([...SCHEDULE_ACTION_KINDS].sort());
    const paths = PAGES.map((p) => p.path);
    for (const page of Object.values(AUTONOMOUS_SURFACES)) expect(paths).toContain(page);
    const labels = readFileSync(join(WEB_SRC, "views", "schedules", "labels.ts"), "utf8");
    const keysOf = (name: string) => [...(new RegExp(`${name}: Record<ActionKind, MessageKey> = \\{([^}]*)\\}`).exec(labels)?.[1] ?? "").matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
    for (const map of ["ACTION_TEXT", "ACTION_ABOUT"]) {
      expect(keysOf(map), `web/src/views/schedules/labels.ts ${map} names every schedule action kind`).toEqual(expect.arrayContaining([...SCHEDULE_ACTION_KINDS]));
    }
  });
});

// The registered background jobs (src/controller/background-jobs.ts) each have an Activity mapping: the actor's name,
// what it does and what it says while idle, in src/ui/activity-api.ts ACTOR_WORDS (design 09-dashboard-activity).
const jobsWithoutActivity = (kinds: readonly string[], words: Readonly<Record<string, { name: string; about: string; idle: string } | undefined>>): string[] =>
  kinds.filter((k) => ![words[k]?.name, words[k]?.about, words[k]?.idle].every((w) => typeof w === "string" && w.trim() !== ""));

describe("background jobs are visible on the Activity page", () => {
  it("every registered background job has an Activity mapping", () => {
    expect(jobsWithoutActivity(BACKGROUND_JOBS.map((j) => j.kind), ACTOR_WORDS)).toEqual([]);
    expect(Object.keys(ACTOR_WORDS).sort()).toEqual(BACKGROUND_JOBS.map((j) => j.kind).sort());
  });

  it("self-check: a registered job with no Activity mapping fails", () => {
    const kinds = [...BACKGROUND_JOBS.map((j) => j.kind), "new_job"];
    expect(jobsWithoutActivity(kinds, ACTOR_WORDS)).toEqual(["new_job"]);
    expect(jobsWithoutActivity(["x"], { x: { name: "", about: "a", idle: "i" } })).toEqual(["x"]);
  });
});
