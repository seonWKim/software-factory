// `npm run build:desktop:macos` (scripts/build-desktop-macos.mjs) on fixture checkouts: a fake Electron.app, never
// the real one, and no install.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = join(import.meta.dirname, "..", "..");
const SCRIPT = join(REPO, "scripts", "build-desktop-macos.mjs");
const APP = "Software Factory.app";

/** A checkout with this repo's package.json and desktop/ (out/ left behind), a factory source file and a node_modules. */
function checkout(withElectron: boolean): string {
  const root = mkdtempSync(join(tmpdir(), "sf-desktop-build-"));
  cpSync(join(REPO, "package.json"), join(root, "package.json"));
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
    writeFileSync(join(app, "Info.plist"), "<key>CFBundleName</key>\n<string>Electron</string>\n<key>CFBundleDisplayName</key>\n<string>Electron</string>\n");
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

  it("copies Electron.app into desktop/out/ as Software Factory.app with the shell in its resources, and nothing else", () => {
    const root = checkout(true);
    const r = build(root);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const app = join(root, "desktop", "out", APP);
    expect(readdirSync(join(root, "desktop", "out"))).toEqual([APP]);
    expect(readFileSync(join(app, "Contents", "MacOS", "Electron"), "utf8")).toBe("binary");
    expect(readFileSync(join(app, "Contents", "Info.plist"), "utf8")).not.toContain("<string>Electron</string>");
    const files = tree(app).map((f) => relative(app, f)).sort();
    const shell = files.filter((f) => f.startsWith("Contents/Resources/app/"));
    expect(shell).toContain("Contents/Resources/app/electron/macos/main.js");
    expect(shell).toContain("Contents/Resources/app/electron/macos/preload.cjs");
    expect(shell).toContain("Contents/Resources/app/electron/common/supervisor.js");
    expect(files).not.toContain("Contents/Resources/default_app.asar");
    expect(files.filter((f) => /node_modules|(^|\/)src\/|\.ts$/.test(f))).toEqual([]);
    expect(files.filter((f) => !f.startsWith("Contents/Resources/app/"))).toEqual(["Contents/Info.plist", "Contents/MacOS/Electron"]);
    const pkg = JSON.parse(readFileSync(join(app, "Contents", "Resources", "app", "package.json"), "utf8"));
    expect(pkg.main).toBe("electron/macos/main.js");
    expect(pkg.softwareFactory.checkout).toBe(root);
  });

  it("desktop/out/ is git-ignored", () => {
    expect(readFileSync(join(REPO, ".gitignore"), "utf8").split("\n")).toContain("desktop/out/");
  });
});
