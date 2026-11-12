// The arguments of `factory migrate` (npm run migrate) and the message it prints before applying.

/** `contract`: only the contract migrations that drop `legacy_*` (RFC 0015 §12 D2). */
type MigrateMode = "apply" | "status" | "dry-run" | "rehearse" | "contract";

export const SQLITE_MIGRATE_MESSAGE =
  "SQLite has no schema scripts: the factory applies additive migrations when it opens the database. `npm run migrate` applies the breaking ones (they rename tables, so a running factory drains first) and the data steps (project keys).";

/**
 * `--status` / `--dry-run` / `--rehearse` / `--contract` as arguments (`npm run migrate -- --status`) or as npm
 * config (`npm run migrate --status` sets npm_config_status).
 */
export function parseMigrateArgs(args: readonly string[], env: Record<string, string | undefined> = {}): MigrateMode | { error: string } {
  const flag = (name: string) => args.includes(`--${name}`) || env[`npm_config_${name.replaceAll("-", "_")}`] === "true";
  const names = ["status", "dry-run", "rehearse", "contract"] as const;
  const unknown = args.filter((a) => !names.some((n) => a === `--${n}`));
  if (unknown.length > 0) return { error: `unknown argument: ${unknown.join(" ")} (use --status, --dry-run, --rehearse or --contract)` };
  const modes = names.filter((m) => flag(m));
  if (modes.length > 1) return { error: "use one of --status, --dry-run, --rehearse and --contract" };
  return modes[0] ?? "apply";
}
