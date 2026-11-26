// The kinds of code (RFC 0023 §3) and the unit each source file belongs to. Pure data: the architecture tests check
// the import rules (R1) with it, and test selection maps a changed file to its unit with it.

export type Kind = "kernel" | "adapter" | "feature" | "engine" | "root" | "web" | "legacy";

export interface Unit {
  kind: Kind;
  /** The unit's name: a component folder, or a feature or adapter folder inside one. */
  name: string;
}

const FEATURE_DIRS = /^src\/(worker\/runs|controller\/units|controller\/handlers|inbound\/handlers|outbound\/handlers|cli\/handlers)\/([^/]+)\//;
const PLUGIN_DIR = /^src\/((?:[a-z-]+\/)+?plugins)\/([^/]+)\//;

// The dashboard's request shell and its route tables wire every ui feature (the *-api.ts routes) together, so they
// are the composition root, not an engine that may not import a feature. The write route table is split by area
// (write-routes-*.ts) with its shared type in write-route-types.ts.
const UI_ROOT = new Set([
  "src/ui/server.ts",
  "src/ui/write-routes.ts",
  "src/ui/write-route-types.ts",
  "src/ui/write-routes-settings.ts",
  "src/ui/write-routes-owner.ts",
  "src/ui/write-routes-work.ts",
  "src/ui/read-routes.ts",
]);

/** The unit of a repo-relative path, or null for a path outside src/ and web/src/. First match wins. */
export function unitOf(path: string): Unit | null {
  if (path.startsWith("web/src/")) return { kind: "web", name: "web" };
  if (!path.startsWith("src/")) return null;
  // The plugin API is the contract plugins implement, so it is kernel, not the composition root.
  if (path.startsWith("src/shared/") || path.startsWith("src/interfaces/") || path === "src/core/types.ts" || path.startsWith("src/core/types/") || path === "src/plugin-api.ts") return { kind: "kernel", name: "kernel" };
  if (/^src\/[^/]+\.tsx?$/.test(path) || UI_ROOT.has(path)) return { kind: "root", name: "root" };
  const impl = /^src\/impl\/([^/]+)\//.exec(path);
  if (impl) return { kind: "adapter", name: `impl/${impl[1]}` };
  const plugin = PLUGIN_DIR.exec(path);
  if (plugin) return { kind: "adapter", name: `${plugin[1]}/${plugin[2]}` };
  const feature = FEATURE_DIRS.exec(path);
  if (feature) return { kind: "feature", name: `${feature[1]}/${feature[2]}` };
  const route = /^src\/ui\/([a-z-]+)-api\.ts$/.exec(path);
  if (route) return { kind: "feature", name: `ui/${route[1]}` };
  if (path.startsWith("src/core/")) return { kind: "legacy", name: "core" };
  const top = /^src\/([^/]+)\//.exec(path);
  return top ? { kind: "engine", name: top[1]! } : null;
}
