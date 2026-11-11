// `npm run build:desktop:macos`: an unsigned "<productName>.app" (Gongbang.app, from desktop/package.json) in
// desktop/out/ (docs/design/09-desktop-app.md). It copies Electron.app from node_modules/electron/dist, renames it,
// puts the shell (desktop/electron/ and a package.json naming this checkout) in its resources, and gives it the mark
// as icon.icns (scripts/build-icons.mjs, from design-system/icon.svg; macOS only). No factory source or node_modules
// goes into the bundle, and it never installs anything: without Electron it says what is missing and exits 1.
// `--root <folder>` builds from another checkout (the tests' fixtures).
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildIcons } from "./build-icons.mjs";

/**
 * Builds the app under `root`; returns its path. Throws an Error whose message says what is missing.
 * `iconOptions` go to buildIcons (the tests fake iconutil).
 */
export function buildDesktopMacos(root, iconOptions = {}) {
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).devDependencies?.electron ?? "(not in devDependencies)";
  const dist = join(root, "node_modules", "electron", "dist");
  if (!existsSync(join(dist, "Electron.app"))) {
    throw new Error(
      `node_modules/electron/dist is missing (Electron.app of electron@${version}). This script never installs it: ` +
        "install the project's dependencies first, then run it again.",
    );
  }
  const pkg = JSON.parse(readFileSync(join(root, "desktop", "package.json"), "utf8"));
  const name = pkg.productName;
  if (typeof name !== "string" || name === "") throw new Error("desktop/package.json has no productName");
  const out = join(root, "desktop", "out");
  const app = join(out, `${name}.app`);
  rmSync(app, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(join(dist, "Electron.app"), app, { recursive: true, verbatimSymlinks: true });

  // Electron runs Resources/app when it exists; its default app is not needed.
  const resources = join(app, "Contents", "Resources");
  rmSync(join(resources, "default_app.asar"), { force: true });
  const icon = bundleIcon(root, resources, iconOptions);

  const plist = join(app, "Contents", "Info.plist");
  if (existsSync(plist)) {
    let text = readFileSync(plist, "utf8").replace(
      /(<key>CFBundle(?:Display)?Name<\/key>\s*<string>)Electron(<\/string>)/g,
      `$1${name}$2`,
    );
    if (icon) text = text.replace(/(<key>CFBundleIconFile<\/key>\s*<string>)[^<]*(<\/string>)/, `$1${icon}$2`);
    writeFileSync(plist, text);
  }

  const shell = join(resources, "app");
  cpSync(join(root, "desktop", "electron"), join(shell, "electron"), {
    recursive: true,
    filter: (src) => !src.endsWith(".d.ts"),
  });
  writeFileSync(join(shell, "package.json"), `${JSON.stringify({ ...pkg, softwareFactory: { checkout: root } }, null, 2)}\n`);
  return app;
}

/**
 * Puts the mark in `resources` as icon.icns in place of Electron's electron.icns; returns its file name, or null
 * where buildIcons makes no icon.icns (not macOS).
 */
function bundleIcon(root, resources, iconOptions) {
  const work = mkdtempSync(join(tmpdir(), "sf-app-icons-"));
  try {
    const files = buildIcons(work, { svg: join(root, "design-system", "icon.svg"), ...iconOptions });
    const icns = files.find((f) => f.endsWith("icon.icns"));
    if (!icns) return null;
    rmSync(join(resources, "electron.icns"), { force: true });
    cpSync(icns, join(resources, "icon.icns"));
    return "icon.icns";
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf("--root");
  const root = at > 0 && process.argv[at + 1] ? resolve(process.argv[at + 1]) : resolve(dirname(fileURLToPath(import.meta.url)), "..");
  try {
    console.log(`built ${buildDesktopMacos(root)} (unsigned)`);
  } catch (e) {
    console.error(`build:desktop:macos: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
