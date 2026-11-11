// `npm run build:icons -- <folder>`: the Gongbang mark (design-system/icon.svg) as PNG files of every size in SIZES,
// and on macOS also icon.icns made with iconutil (docs/design/09-brand-and-tokens.md).
// No rasterizer is installed, so this script draws the SVG itself. It reads only what the mark uses: <rect> (with
// rx), <circle> and <path> with absolute M, L, H, V, C and Z, each with a hex fill and an optional fill-rule. An
// element with data-min-px="N" is drawn only at N px and up (the ember dot).
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync, inflateSync } from "node:zlib";

/** The PNG sizes, in px. */
export const SIZES = [16, 32, 64, 128, 256, 512, 1024];

/** The master mark. */
export const MASTER_SVG = join(dirname(fileURLToPath(import.meta.url)), "..", "design-system", "icon.svg");

/** iconutil's names in an .iconset folder, and the size each one holds. */
const ICONSET = [16, 32, 128, 256, 512].flatMap((n) => [
  [`icon_${n}x${n}.png`, n],
  [`icon_${n}x${n}@2x.png`, n * 2],
]);

const attrs = (tag) => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
const num = (v) => Number.parseFloat(v ?? "0");

/** The SVG's view box and its drawable shapes, in order: `{ fill: [r, g, b], evenodd, minPx, polys }`. */
export function parseSvg(text) {
  const box = /viewBox="([^"]+)"/.exec(text)?.[1].trim().split(/[\s,]+/).map(Number);
  if (!box || box.length !== 4) throw new Error("the SVG has no viewBox");
  const shapes = [];
  for (const m of text.replace(/<!--[\s\S]*?-->/g, "").matchAll(/<(rect|circle|path)\b([^>]*)>/g)) {
    const a = attrs(m[2]);
    const fill = /^#([0-9a-fA-F]{6})$/.exec(a.fill ?? "");
    if (!fill) throw new Error(`<${m[1]}> needs a fill of six hex digits`);
    const d = m[1] === "path" ? a.d : m[1] === "rect" ? rectPath(a) : circlePath(num(a.cx), num(a.cy), num(a.r));
    shapes.push({
      fill: [0, 2, 4].map((i) => Number.parseInt(fill[1].slice(i, i + 2), 16)),
      evenodd: a["fill-rule"] === "evenodd",
      minPx: num(a["data-min-px"]),
      polys: flatten(d ?? ""),
    });
  }
  return { box, shapes };
}

const K = 0.5522847498; // a quarter circle as one cubic Bézier

function circlePath(cx, cy, r) {
  const c = r * K;
  return `M${cx} ${cy - r}C${cx + c} ${cy - r} ${cx + r} ${cy - c} ${cx + r} ${cy}C${cx + r} ${cy + c} ${cx + c} ${cy + r} ${cx} ${cy + r}` +
    `C${cx - c} ${cy + r} ${cx - r} ${cy + c} ${cx - r} ${cy}C${cx - r} ${cy - c} ${cx - c} ${cy - r} ${cx} ${cy - r}Z`;
}

function rectPath(a) {
  const [x, y, w, h] = [num(a.x), num(a.y), num(a.width), num(a.height)];
  const r = Math.min(num(a.rx ?? a.ry), w / 2, h / 2);
  const c = r * (1 - K);
  return `M${x + r} ${y}H${x + w - r}C${x + w - c} ${y} ${x + w} ${y + c} ${x + w} ${y + r}V${y + h - r}` +
    `C${x + w} ${y + h - c} ${x + w - c} ${y + h} ${x + w - r} ${y + h}H${x + r}C${x + c} ${y + h} ${x} ${y + h - c} ${x} ${y + h - r}` +
    `V${y + r}C${x} ${y + c} ${x + c} ${y} ${x + r} ${y}Z`;
}

/** A path's closed polygons; each curve becomes 24 straight segments. */
export function flatten(d) {
  const tokens = d.match(/[MLHVCZ]|-?(?:\d+\.?\d*|\.\d+)/g) ?? [];
  const bad = d.replace(/[MLHVCZ\s,]|-?(?:\d+\.?\d*|\.\d+)/g, "");
  if (bad) throw new Error(`path command not supported: ${bad[0]}`);
  const polys = [];
  let poly = [];
  let x = 0;
  let y = 0;
  let cmd = "";
  let i = 0;
  const next = () => Number(tokens[i++]);
  const close = () => {
    if (poly.length > 2) polys.push(poly);
    poly = [];
  };
  while (i < tokens.length) {
    if (/[A-Z]/.test(tokens[i])) cmd = tokens[i++];
    if (cmd === "M") {
      close();
      [x, y] = [next(), next()];
      poly.push([x, y]);
      cmd = "L";
    } else if (cmd === "L") poly.push([(x = next()), (y = next())]);
    else if (cmd === "H") poly.push([(x = next()), y]);
    else if (cmd === "V") poly.push([x, (y = next())]);
    else if (cmd === "C") {
      const [x1, y1, x2, y2, x3, y3] = [next(), next(), next(), next(), next(), next()];
      for (let s = 1; s <= 24; s++) {
        const t = s / 24;
        const u = 1 - t;
        poly.push([
          u * u * u * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
          u * u * u * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
        ]);
      }
      [x, y] = [x3, y3];
    } else if (cmd === "Z") {
      close();
      if (/[A-Z]/.test(tokens[i] ?? "")) continue;
      break;
    }
  }
  close();
  return polys;
}

const SUB = 16; // scanlines per pixel row; across a row, coverage is exact

/** One shape's coverage (0..1) of each pixel of a `size` px render. */
function coverage(shape, scale, size) {
  const cov = new Float32Array(size * size);
  const edges = shape.polys.flatMap((p) =>
    p.map((a, i) => {
      const b = p[(i + 1) % p.length];
      return [a[0] * scale, a[1] * scale, b[0] * scale, b[1] * scale];
    }),
  ).filter((e) => e[1] !== e[3]);
  for (let row = 0; row < size; row++) {
    for (let s = 0; s < SUB; s++) {
      const sy = row + (s + 0.5) / SUB;
      const hits = [];
      for (const [x0, y0, x1, y1] of edges) {
        if (sy < Math.min(y0, y1) || sy >= Math.max(y0, y1)) continue;
        hits.push([x0 + ((sy - y0) / (y1 - y0)) * (x1 - x0), y1 > y0 ? 1 : -1]);
      }
      hits.sort((a, b) => a[0] - b[0]);
      let wind = 0;
      for (let h = 0; h < hits.length - 1; h++) {
        wind = shape.evenodd ? wind ^ 1 : wind + hits[h][1];
        if (wind !== 0) addSpan(cov, row * size, size, hits[h][0], hits[h + 1][0], 1 / SUB);
      }
    }
  }
  return cov;
}

function addSpan(cov, at, size, from, to, weight) {
  const a = Math.max(0, from);
  const b = Math.min(size, to);
  for (let px = Math.floor(a); px < b; px++) {
    const part = Math.min(b, px + 1) - Math.max(a, px);
    if (part > 0) cov[at + px] += part * weight;
  }
}

/** The SVG drawn at `size` × `size` px: straight RGBA bytes, row by row. */
export function render(svg, size) {
  const scale = size / Math.max(svg.box[2], svg.box[3]);
  const rgba = new Float64Array(size * size * 4);
  for (const shape of svg.shapes) {
    if (size < shape.minPx) continue;
    const cov = coverage(
      { ...shape, polys: shape.polys.map((p) => p.map(([x, y]) => [x - svg.box[0], y - svg.box[1]])) },
      scale,
      size,
    );
    for (let i = 0; i < cov.length; i++) {
      const a = Math.min(1, cov[i]);
      if (a <= 0) continue;
      const da = rgba[i * 4 + 3];
      const oa = a + da * (1 - a);
      for (let c = 0; c < 3; c++) rgba[i * 4 + c] = (shape.fill[c] * a + rgba[i * 4 + c] * da * (1 - a)) / oa;
      rgba[i * 4 + 3] = oa;
    }
  }
  const out = Buffer.alloc(size * size * 4);
  for (let i = 0; i < rgba.length; i++) out[i] = Math.round(i % 4 === 3 ? rgba[i] * 255 : rgba[i]);
  return out;
}

/** RGBA bytes as a PNG file (8-bit RGBA, no filter). */
export function encodePng(rgba, size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(size, 0);
  head.writeUInt32BE(size, 4);
  head[8] = 8; // bit depth
  head[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", head),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * A PNG written by encodePng back to `{ width, height, rgba }`. Compare pixels, not file bytes: deflate's output
 * differs between zlib builds (macOS vs Linux) for the same image.
 */
export function decodePng(png) {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (png[24] !== 8 || png[25] !== 6) throw new Error("decodePng reads only 8-bit RGBA");
  const idat = [];
  for (let at = 8; at < png.length; ) {
    const len = png.readUInt32BE(at);
    if (png.toString("ascii", at + 4, at + 8) === "IDAT") idat.push(png.subarray(at + 8, at + 8 + len));
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const row = width * 4 + 1;
  if (raw.length !== row * height) throw new Error("decodePng: pixel data does not match the size");
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    if (raw[y * row] !== 0) throw new Error("decodePng reads only unfiltered rows");
    raw.copy(rgba, y * width * 4, y * row + 1, (y + 1) * row);
  }
  return { width, height, rgba };
}

/** The PNG file name of one size. */
export const pngName = (size) => `icon-${size}.png`;

/**
 * Writes one PNG per size in SIZES into `out`, and icon.icns on macOS (`platform` "darwin") with
 * `run("iconutil", args)`. Elsewhere it skips icon.icns and says so through `log`. Returns the files written.
 */
export function buildIcons(out, { svg = MASTER_SVG, platform = process.platform, run = execFileSync, log = console.log } = {}) {
  const mark = parseSvg(readFileSync(svg, "utf8"));
  mkdirSync(out, { recursive: true });
  const written = SIZES.map((size) => {
    const file = join(out, pngName(size));
    writeFileSync(file, encodePng(render(mark, size), size));
    return file;
  });
  if (platform !== "darwin") {
    log(`build-icons: icon.icns skipped: iconutil runs only on macOS (this is ${platform})`);
    return written;
  }
  const work = mkdtempSync(join(tmpdir(), "sf-iconset-"));
  try {
    const set = join(work, "icon.iconset");
    mkdirSync(set);
    for (const [name, size] of ICONSET) copyFileSync(join(out, pngName(size)), join(set, name));
    const icns = join(out, "icon.icns");
    run("iconutil", ["-c", "icns", "-o", icns, set]);
    return [...written, icns];
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2];
  if (!out) {
    console.error("usage: node scripts/build-icons.mjs <folder>");
    process.exit(1);
  }
  try {
    for (const f of buildIcons(resolve(out))) console.log(`wrote ${f}`);
  } catch (e) {
    console.error(`build-icons: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
