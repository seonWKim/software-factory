// `npm run build:desktop:macos` (scripts/build-desktop-macos.mjs) on fixture checkouts: a fake Electron.app, never
// the real one, no install, and a fake iconutil.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = join(import.meta.dirname, "..", "..");
const SCRIPT = join(REPO, "scripts", "build-desktop-macos.mjs");
const APP = "Gongbang.app";
type IconOptions = { platform?: string; run?: (cmd: string, args: string[]) => void; log?: (m: string) => void };
const { buildDesktopMacos } = (await import(pathToFileURL(SCRIPT).href as string)) as {
  buildDesktopMacos: (root: string, iconOptions?: IconOptions) => string;
};
/** iconutil as far as the build needs it: writes the -o file. */
const fakeIconutil = (cmd: string, args: string[]) => writeFileSync(args[args.indexOf("-o") + 1]!, `icns from ${cmd}`);

/** A checkout with this repo's package.json and desktop/ (out/ left behind), a factory source file and a node_modules. */
function checkout(withElectron: boolean): string {
  const root = mkdtempSync(join(tmpdir(), "sf-desktop-build-"));
  cpSync(join(REPO, "package.json"), join(root, "package.json"));
  cpSync(join(REPO, "design-system", "icon.svg"), join(root, "design-system", "icon.svg"));
  cpSync(join(REPO, "desktop"), join(root, "desktop"), { recursive: true, filter: (s) => !s.includes(`${join("desktop", "out")}`) });
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "main.ts"), "factory source");
  mkdirSync(join(root, "node_modules", "some-dep"), { recursive: true });
  if (withElectron) {
    const app = join(root, "node_modules", "electron", "dist", "Electron.app", "Contents");
    mkdirSync(join(app, "MacOS"), { recursive: true });
    mkdirSync(join(app, "Resources"), { recursive: true });
    writeFileSync(join(app, "MacOS", "Electron"), "binary");
    writeFileSync(join(app, "Resources", "default_app.asar"), "default app");
    writeFileSync(join(app, "Resources", "electron.icns"), "electron icon");
    writeFileSync(
      join(app, "Info.plist"),
      "<key>CFBundleName</key>\n<string>Electron</string>\n<key>CFBundleDisplayName</key>\n<string>Electron</string>\n" +
        "<key>CFBundleIconFile</key>\n<string>electron.icns</string>\n",
    );
  }
  return root;
}

const build = (root: string) => spawnSync(process.execPath, [SCRIPT, "--root", root], { encoding: "utf8" });

function tree(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? tree(join(dir, e.name)) : [join(dir, e.name)],
  );
}

describe("build:desktop:macos", () => {
  it("is the npm script", () => {
    const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
    expect(pkg.scripts["build:desktop:macos"]).toBe("node scripts/build-desktop-macos.mjs");
  });

  it("without node_modules/electron/dist exits 1 naming the pinned electron and the missing folder, and installs nothing", () => {
    const root = checkout(false);
    const pinned = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).devDependencies.electron;
    const r = build(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`electron@${pinned}`);
    expect(r.stderr).toContain("node_modules/electron/dist");
    expect(existsSync(join(root, "node_modules", "electron"))).toBe(false);
    expect(existsSync(join(root, "package-lock.json"))).toBe(false);
    expect(existsSync(join(root, "desktop", "out"))).toBe(false);
  });

  it("copies Electron.app into desktop/out/ as Gongbang.app (desktop/package.json productName) with the shell and the mark in its resources, and nothing else", () => {
    const root = checkout(true);
    const app = buildDesktopMacos(root, { platform: "darwin", run: fakeIconutil, log: () => {} });
    expect(app).toBe(join(root, "desktop", "out", APP));
    expect(readdirSync(join(root, "desktop", "out"))).toEqual([APP]);
    expect(readFileSync(join(app, "Contents", "MacOS", "Electron"), "utf8")).toBe("binary");
    const plist = readFileSync(join(app, "Contents", "Info.plist"), "utf8");
    expect(plist).not.toContain("<string>Electron</string>");
    expect(plist).toMatch(/<key>CFBundleName<\/key>\s*<string>Gongbang<\/string>/);
    expect(plist).toMatch(/<key>CFBundleDisplayName<\/key>\s*<string>Gongbang<\/string>/);
    expect(plist).toMatch(/<key>CFBundleIconFile<\/key>\s*<string>icon\.icns<\/string>/);
    expect(readFileSync(join(app, "Contents", "Resources", "icon.icns"), "utf8")).toBe("icns from iconutil");
    const files = tree(app).map((f) => relative(app, f)).sort();
    const shell = files.filter((f) => f.startsWith("Contents/Resources/app/"));
    expect(shell).toContain("Contents/Resources/app/electron/macos/main.js");
    expect(shell).toContain("Contents/Resources/app/electron/macos/preload.cjs");
    expect(shell).toContain("Contents/Resources/app/electron/common/supervisor.js");
    expect(files).not.toContain("Contents/Resources/default_app.asar");
    expect(files.filter((f) => /node_modules|(^|\/)src\/|\.ts$/.test(f))).toEqual([]);
    expect(files.filter((f) => !f.startsWith("Contents/Resources/app/"))).toEqual(
      ["Contents/Info.plist", "Contents/MacOS/Electron", "Contents/Resources/icon.icns"],
    );
    const pkg = JSON.parse(readFileSync(join(app, "Contents", "Resources", "app", "package.json"), "utf8"));
    expect(pkg.main).toBe("electron/macos/main.js");
    expect(pkg.softwareFactory.checkout).toBe(root);
  });

  it("off macOS keeps Electron's icon: buildIcons makes no icon.icns there", () => {
    const root = checkout(true);
    const app = buildDesktopMacos(root, { platform: "linux", log: () => {} });
    expect(existsSync(join(app, "Contents", "Resources", "icon.icns"))).toBe(false);
    expect(readFileSync(join(app, "Contents", "Info.plist"), "utf8")).toContain("<string>electron.icns</string>");
  });

  it("desktop/out/ is git-ignored", () => {
    expect(readFileSync(join(REPO, ".gitignore"), "utf8").split("\n")).toContain("desktop/out/");
  });
});
