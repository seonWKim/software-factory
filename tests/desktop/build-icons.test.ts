// scripts/build-icons.mjs on a temp folder: every PNG size, icon.icns through iconutil on macOS only (iconutil
// faked: the test never needs it installed), and the ember dot at every size.
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

const REPO = join(import.meta.dirname, "..", "..");
const SVG = join(REPO, "design-system", "icon.svg");

type Run = (cmd: string, args: string[]) => void;
type Options = { svg?: string; platform?: string; run?: Run; log?: (m: string) => void };
type Svg = { box: number[]; shapes: unknown[] };
const icons = (await import(pathToFileURL(join(REPO, "scripts", "build-icons.mjs")).href as string)) as {
  SIZES: number[];
  buildIcons: (out: string, o?: Options) => string[];
  parseSvg: (text: string) => Svg;
  render: (svg: Svg, size: number) => Buffer;
  encodePng: (rgba: Buffer, size: number) => Buffer;
  pngName: (size: number) => string;
};

/** A PNG's width, height and RGBA pixel at (x, y); the builder writes 8-bit RGBA with no row filter. */
function png(file: string) {
  const b = readFileSync(file);
  expect(b.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const width = b.readUInt32BE(16);
  const height = b.readUInt32BE(20);
  const idat: Buffer[] = [];
  for (let at = 8; at < b.length; ) {
    const len = b.readUInt32BE(at);
    if (b.toString("ascii", at + 4, at + 8) === "IDAT") idat.push(b.subarray(at + 8, at + 8 + len));
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const pixel = (x: number, y: number) => [...raw.subarray(y * (width * 4 + 1) + 1 + x * 4, y * (width * 4 + 1) + 5 + x * 4)];
  return { width, height, pixel };
}

/** The pixel under master-SVG point (x, y) in a `size` px render. */
const at = (p: ReturnType<typeof png>, size: number, x: number, y: number) => p.pixel(Math.floor((x * size) / 1024), Math.floor((y * size) / 1024));

const temp = () => mkdtempSync(join(tmpdir(), "sf-icons-"));
const SQUARE = [0x1c, 0x1c, 0x1e, 255];
const WHITE = [255, 255, 255, 255];

describe("design-system/icon.svg", () => {
  it("is a white 공 drawn as outlines on a rounded #1C1C1E square, with an ember dot at every size", () => {
    const text = readFileSync(SVG, "utf8");
    expect(text).toMatch(/<rect id="square"[^>]* rx="\d+"[^>]* fill="#1C1C1E"/);
    expect(text).toMatch(/<path id="glyph"[^>]* fill="#FFFFFF"/);
    expect(text).toMatch(/<circle id="ember" data-small-r="2\.5" cx="800" cy="224" r="44" fill="#FB923C"/);
    expect(text).not.toContain("data-min-px");
    expect(text).not.toMatch(/<text|font-family|<use|<image/);
  });
});

describe("build-icons", () => {
  it("writes the seven PNG sizes; off macOS it skips icon.icns and says so", () => {
    const out = temp();
    const said: string[] = [];
    const ran: string[] = [];
    const files = icons.buildIcons(out, { platform: "linux", run: (cmd) => void ran.push(cmd), log: (m) => said.push(m) });
    expect(icons.SIZES).toEqual(expect.arrayContaining([16, 32, 64, 128, 256, 512, 1024]));
    for (const size of [16, 32, 64, 128, 256, 512, 1024]) {
      const p = png(join(out, icons.pngName(size)));
      expect([p.width, p.height]).toEqual([size, size]);
      expect(files).toContain(join(out, icons.pngName(size)));
    }
    expect(existsSync(join(out, "icon.icns"))).toBe(false);
    expect(ran).toEqual([]);
    expect(said.join("\n")).toMatch(/icon\.icns skipped.*macOS/);
  });

  it("on macOS also writes icon.icns with iconutil, from an iconset of every size it needs", () => {
    const out = temp();
    const calls: { cmd: string; args: string[]; set: Record<string, number> }[] = [];
    const run: Run = (cmd, args) => {
      const set = args[args.length - 1]!;
      const sizes = Object.fromEntries(readdirSync(set).map((f) => [f, png(join(set, f)).width]));
      calls.push({ cmd, args, set: sizes });
      writeFileSync(args[args.indexOf("-o") + 1]!, "icns");
    };
    const files = icons.buildIcons(out, { platform: "darwin", run, log: () => {} });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe("iconutil");
    expect(calls[0]!.args.slice(0, 4)).toEqual(["-c", "icns", "-o", join(out, "icon.icns")]);
    expect(calls[0]!.set).toMatchObject({
      "icon_16x16.png": 16, "icon_16x16@2x.png": 32, "icon_32x32.png": 32, "icon_32x32@2x.png": 64,
      "icon_128x128.png": 128, "icon_128x128@2x.png": 256, "icon_256x256.png": 256, "icon_256x256@2x.png": 512,
      "icon_512x512.png": 512, "icon_512x512@2x.png": 1024,
    });
    expect(files).toContain(join(out, "icon.icns"));
    expect(readFileSync(join(out, "icon.icns"), "utf8")).toBe("icns");
    expect(png(join(out, icons.pngName(1024))).width).toBe(1024);
  });

  it("draws the square, the white 공 and transparent corners", () => {
    const out = temp();
    icons.buildIcons(out, { platform: "linux", log: () => {} });
    for (const size of [16, 32, 64, 128, 256, 512, 1024]) {
      const p = png(join(out, icons.pngName(size)));
      expect(p.pixel(0, 0)[3], `${size} corner`).toBe(0);
      if (size >= 64) expect(at(p, size, 512, 533), `${size} bar of ㅗ`).toEqual(WHITE);
      if (size >= 32) expect(at(p, size, 512, 724), `${size} hole of ㅇ`).toEqual(SQUARE);
    }
  });

  it("draws the ember dot #FB923C at its centre at 16, 32, 64 and 1024 px", () => {
    const out = temp();
    icons.buildIcons(out, { platform: "linux", log: () => {} });
    for (const size of [16, 32, 64, 1024]) {
      expect(at(png(join(out, icons.pngName(size))), size, 800, 224), `${size} ember`).toEqual([0xfb, 0x92, 0x3c, 255]);
    }
  });

  it("refuses an SVG it cannot draw instead of drawing it wrong", () => {
    const dir = temp();
    const svg = join(dir, "x.svg");
    writeFileSync(svg, '<svg viewBox="0 0 10 10"><path fill="#000000" d="M0 0a5 5 0 0 1 10 0Z"/></svg>');
    expect(() => icons.buildIcons(join(dir, "out"), { svg, platform: "linux", log: () => {} })).toThrow(/not supported: a/);
  });
});
