/** `updater.auto_migrate` from factory.config.json: absent means false, otherwise a boolean or startup fails. */
export function autoMigrate(updater: { auto_migrate?: unknown } | undefined): boolean {
  const v = updater?.auto_migrate;
  if (v === undefined) return false;
  if (typeof v !== "boolean") throw new Error("updater.auto_migrate must be true or false");
  return v;
}
