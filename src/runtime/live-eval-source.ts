// The eval source a process uses (design 08-settings, 2026-11-24): SkillEvalSource is an integration, so the runtime
// `integrations` entry's `eval_source` names it, else the config's `plugins.eval_source`. Unlike the tacit holder
// (live-tacit.ts) nothing is held: each import or try refreshes the settings, reads the name and builds that plugin
// through the registry, so a switch applies on the next call with no restart. The source is read structurally (the
// SkillEvalSource interface's `enabled`): a runtime component imports no legacy module.

/** The settings a call reads the entry from: LiveSettings, refreshed before each read. */
export interface IntegrationSettings {
  refresh(): Promise<void>;
  values(): { integrations: Readonly<Record<string, string>> };
}

export interface EvalSourceSwitch<S extends { readonly enabled: boolean }> {
  /** `plugins.eval_source`; absent when config selects none. */
  configured: string | undefined;
  /** Every registered SkillEvalSource plugin name. */
  registered: readonly string[];
  settings: IntegrationSettings;
  /** Builds the named source through the registry; called only with a registered name. */
  open(name: string): Promise<S>;
}

export const NO_EVAL_SOURCE =
  "no eval source is on: turn one on in the integrations setting or set plugins.eval_source in factory.config.json: nothing written";

/** The integrations entry's `eval_source`, else the config's, after a refresh; null when neither names one. */
export async function evalSourceName(s: Pick<EvalSourceSwitch<never>, "configured" | "settings">): Promise<string | null> {
  await s.settings.refresh();
  return s.settings.values().integrations.eval_source ?? s.configured ?? null;
}

/** The source in force, built for this call, or why there is none (no name, an unknown name, or `none`). */
export async function liveEvalSource<S extends { readonly enabled: boolean }>(s: EvalSourceSwitch<S>): Promise<{ name: string; source: S } | { refused: string }> {
  const name = await evalSourceName(s);
  if (name === null) return { refused: NO_EVAL_SOURCE };
  if (!s.registered.includes(name)) return { refused: `unknown eval source ${JSON.stringify(name)}; available: ${s.registered.join(", ")}: nothing written` };
  const source = await s.open(name);
  return source.enabled ? { name, source } : { refused: NO_EVAL_SOURCE };
}
