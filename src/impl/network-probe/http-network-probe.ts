// The `http` NetworkProbe (design §5 Restarts, network pause): one HEAD request to each endpoint the selected
// plugins talk to, with no credential and no body. Any HTTP answer, whatever its status, means the network is
// back; a DNS, connect or timeout error means it is not. Only the host of a failing endpoint is reported.

import type { NetworkProbe, NetworkProbeResult } from "../../interfaces/network-probe.js";
import type { Selection } from "../../plugin-api.js";
import { selectedLlms, selectedRunners, selectedSources } from "../../plugin-api.js";
import type { OpenAICompatibleConfig } from "../openai/config.js";

/** The GitHub REST API every GitHub plugin calls; git pushes go to the same forge. */
export const GITHUB_API = "https://api.github.com";
/** The model API the Claude CLI plugins (claude-code, claude-cli) call. */
export const ANTHROPIC_API = "https://api.anthropic.com";

/** How long one HEAD may take before its endpoint counts as unreachable. */
export const PROBE_TIMEOUT_MS = 10_000;

/** The plugins that talk to GitHub, by kind. */
const GITHUB_PLUGINS: Partial<Record<keyof Selection, string>> = { broker: "github", forge: "github", auth: "github" };

/**
 * The endpoints of the selected plugins, without duplicates: GitHub when a GitHub plugin is selected (never
 * otherwise: local first), the model's API for the runner and LLM chains. Read from the existing config only.
 */
export function probeTargets(plugins: Selection, file: { openai_compatible?: OpenAICompatibleConfig }): string[] {
  const out = new Set<string>();
  const github =
    Object.entries(GITHUB_PLUGINS).some(([kind, name]) => plugins[kind as keyof Selection] === name) ||
    selectedSources(plugins).includes("github-issues");
  if (github) out.add(GITHUB_API);
  for (const name of [...selectedRunners(plugins), ...selectedLlms(plugins)]) {
    if (name === "claude-code" || name === "claude-cli") out.add(ANTHROPIC_API);
    if (name === "openai-compatible" && file.openai_compatible?.base_url) out.add(file.openai_compatible.base_url);
  }
  return [...out];
}

export class HttpNetworkProbe implements NetworkProbe {
  constructor(
    readonly targets: readonly string[],
    private readonly fetchFn: typeof fetch = fetch,
    private readonly timeout_ms = PROBE_TIMEOUT_MS,
  ) {}

  async probe(signal?: AbortSignal): Promise<NetworkProbeResult> {
    for (const target of this.targets) {
      const timeout = AbortSignal.timeout(this.timeout_ms);
      try {
        const res = await this.fetchFn(target, { method: "HEAD", redirect: "manual", signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
        // The answer's body is never read; HEAD has none, and dropping it frees the connection.
        await res.body?.cancel().catch(() => undefined);
      } catch {
        return { ok: false, host: hostOf(target) };
      }
    }
    return { ok: true };
  }
}

/** A target's host name only: no path, no query, no user info. */
function hostOf(target: string): string {
  try {
    return new URL(target).host;
  } catch {
    return "unknown host";
  }
}
