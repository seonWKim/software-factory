// `npm run build:desktop:macos`: an unsigned "Software Factory.app" in desktop/out/ (docs/design/09-desktop-app.md).
// It copies Electron.app from node_modules/electron/dist, renames it, and puts the shell (desktop/electron/ and a
// package.json naming this checkout) in its resources. No factory source or node_modules goes into the bundle, and
// it never installs anything: without Electron it says what is missing and exits 1.
// `--root <folder>` builds from another checkout (the tests' fixtures).
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_NAME = "Software Factory";

/** Builds the app under `root`; returns its path. Throws an Error whose message says what is missing. */
export function buildDesktopMacos(root) {
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).devDependencies?.electron ?? "(not in devDependencies)";
  const dist = join(root, "node_modules", "electron", "dist");
  if (!existsSync(join(dist, "Electron.app"))) {
    throw new Error(
      `node_modules/electron/dist is missing (Electron.app of electron@${version}). This script never installs it: ` +
        "install the project's dependencies first, then run it again.",
    );
  }
  const out = join(root, "desktop", "out");
  const app = join(out, `${APP_NAME}.app`);
  rmSync(app, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(join(dist, "Electron.app"), app, { recursive: true, verbatimSymlinks: true });

  const plist = join(app, "Contents", "Info.plist");
  if (existsSync(plist)) {
    const text = readFileSync(plist, "utf8").replace(
      /(<key>CFBundle(?:Display)?Name<\/key>\s*<string>)Electron(<\/string>)/g,
      `$1${APP_NAME}$2`,
    );
    writeFileSync(plist, text);
  }

  // Electron runs Resources/app when it exists; its default app is not needed.
  const resources = join(app, "Contents", "Resources");
  rmSync(join(resources, "default_app.asar"), { force: true });
  const shell = join(resources, "app");
  cpSync(join(root, "desktop", "electron"), join(shell, "electron"), {
    recursive: true,
    filter: (src) => !src.endsWith(".d.ts"),
  });
  const pkg = JSON.parse(readFileSync(join(root, "desktop", "package.json"), "utf8"));
  writeFileSync(join(shell, "package.json"), `${JSON.stringify({ ...pkg, softwareFactory: { checkout: root } }, null, 2)}\n`);
  return app;
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
