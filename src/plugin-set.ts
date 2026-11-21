// The configured plugins, built one at a time through the plugin registry: what build() wires, and what setup,
// doctor, the canary and plugin import call without building a whole factory. Kept out of compose.ts (the
// composition root) so that code can resolve plugins without importing the root (RFC 0023 §5 step 2b).

import { FallbackLLM } from "./core/fallback-llm.js";
import { FallbackRunner } from "./core/fallback-runner.js";
import type { Loaded } from "./load-config.js";
import type { AgentRunner } from "./interfaces/agent-runner.js";
import type { EgressScanner } from "./interfaces/egress-scanner.js";
import type { FactoryStore } from "./interfaces/factory-store.js";
import type { Forge } from "./interfaces/forge.js";
import type { GitHubAccess, GitHubApi, GitHubCredentials } from "./interfaces/github-credentials.js";
import type { LLMProvider } from "./interfaces/llm-provider.js";
import type { Sandbox } from "./interfaces/sandbox.js";
import type { SecretStore } from "./interfaces/secret-store.js";
import type { ToolBroker } from "./interfaces/tool-broker.js";
import type { Logger } from "./core/log.js";
import type { ConnectContext } from "./plugin-api.js";
import { type BaseContext, createPlugin, selectedLlms, selectedRunners } from "./plugins.js";
import type { LocalRoute } from "./worker/index.js";

/** The Clock port, named through the plugin API so this file reads no clock itself (tests/architecture/no-clock). */
type Clock = ConnectContext["clock"];

/** The broker plugin local items always take (Plugins.localRoute). */
const LOCAL_BROKER = "local";

/** A stand-in that refuses every call with `why`. Not a thenable: awaiting it must not hang. */
function refusing<T>(why: string): T {
  return new Proxy({}, { get: (_target, key) => (key === "then" ? undefined : () => Promise.reject(new Error(why))) }) as T;
}

const NO_GITHUB = "no GitHub plugin is selected (design 05-sources, Local startup): nothing calls GitHub";

/** What every broker plugin is built with, beside the base context. */
export interface BrokerDeps { github: GitHubApi; credentials: GitHubCredentials; secrets: SecretStore; store: FactoryStore; scanner: EgressScanner; clock: Clock }

/**
 * Resolves the configured plugins one at a time, through the same registry as build(). For code that needs
 * only some of them: setup, doctor and the G6 canary, so they exercise the configured guards.
 */
export class Plugins {
  readonly base: BaseContext;
  /** The github_auth plugin's build, made once: one forge client per Plugins, so per build() and per command. */
  private access: Promise<GitHubAccess> | undefined;

  constructor(
    readonly loaded: Loaded,
    opts: { extraScanValues?: readonly string[] } = {},
  ) {
    const { owner, name } = loaded.config.repo;
    this.base = { loaded, repo: { owner, name }, extraScanValues: opts.extraScanValues ?? [] };
  }

  clock(): Promise<Clock> {
    return createPlugin(this.loaded.registry, "clock", this.loaded.plugins.clock, this.base);
  }
  secrets(): Promise<SecretStore> {
    return createPlugin(this.loaded.registry, "secrets", this.loaded.plugins.secrets, this.base);
  }
  scanner(secrets: SecretStore): Promise<EgressScanner> {
    return createPlugin(this.loaded.registry, "egress", this.loaded.plugins.egress, { ...this.base, secrets });
  }
  store(secrets: SecretStore, clock: Clock): Promise<FactoryStore> {
    return createPlugin(this.loaded.registry, "store", this.loaded.plugins.store, { ...this.base, secrets, clock });
  }
  /** One provider, or a FallbackLLM over the `plugins.llm` chain (design 2026-11-07). */
  async llm(secrets: SecretStore): Promise<LLMProvider> {
    const names = selectedLlms(this.loaded.plugins);
    const members = [];
    for (const name of names) members.push({ name, impl: await createPlugin(this.loaded.registry, "llm", name, { ...this.base, secrets }) });
    return members.length === 1 ? members[0]!.impl : new FallbackLLM(members);
  }
  sandbox(): Promise<Sandbox> {
    return createPlugin(this.loaded.registry, "sandbox", this.loaded.plugins.sandbox, this.base);
  }
  /**
   * The credentials and the one forge client the selected github_auth plugin builds, on the first call; later
   * calls get the same ones. With no GitHub plugin selected (design 05-sources, Local startup): stand-ins that
   * refuse every call, so no GitHub credential is read and no request is made. `deps`: the secret store and Clock
   * a caller already has (build()); absent, the configured ones.
   */
  githubAccess(deps?: { secrets: SecretStore; clock: Clock }): Promise<GitHubAccess> {
    this.access ??= this.loaded.config.local_only === true
      ? Promise.resolve({ credentials: refusing<GitHubCredentials>(NO_GITHUB), api: refusing<GitHubApi>(NO_GITHUB) })
      : (async () => {
          const { secrets, clock } = deps ?? { secrets: await this.secrets(), clock: await this.clock() };
          return createPlugin(this.loaded.registry, "github_auth", this.loaded.plugins.github_auth, { ...this.base, secrets, clock });
        })();
    return this.access;
  }
  /** The process's forge client (githubAccess): what the CLI commands, setup and doctor call the forge through. */
  async githubApi(): Promise<GitHubApi> {
    return (await this.githubAccess()).api;
  }
  /**
   * Where local items go (design 05-sources, Local items): the `local` broker and the selected sandbox plugin on
   * the local base branch. With no GitHub plugin selected those are `selected` already; otherwise both are built
   * here beside them, from the same registry, with no new config key. Never a credential: the local broker has none.
   */
  async localRoute(selected: LocalRoute, deps: BrokerDeps): Promise<LocalRoute> {
    if (this.loaded.config.local_only === true) return selected;
    const loaded: Loaded = { ...this.loaded, config: { ...this.loaded.config, local_only: true } };
    const base = { ...this.base, loaded };
    const sandbox = await createPlugin(loaded.registry, "sandbox", loaded.plugins.sandbox, base);
    const broker = this.loaded.plugins.broker === LOCAL_BROKER ? selected.broker : await createPlugin(loaded.registry, "broker", LOCAL_BROKER, { ...base, ...deps });
    return { broker, sandbox };
  }
  /** `tools`: the broker and scanner a runner exposes granted tools through; left out where nothing is granted. */
  /** One runner, or a FallbackRunner over the `plugins.runner` chain (design 2026-11-07). */
  async runner(sandbox: Sandbox, secrets: SecretStore, tools?: { broker: ToolBroker; scanner: EgressScanner }): Promise<AgentRunner> {
    const names = selectedRunners(this.loaded.plugins);
    const members = [];
    for (const name of names) members.push({ name, impl: await createPlugin(this.loaded.registry, "runner", name, { ...this.base, sandbox, secrets, ...tools }) });
    return members.length === 1 ? members[0]!.impl : new FallbackRunner(members);
  }
  /**
   * The selected forge (`plugins.forge`, or the one `plugins.source` implies; issue #273), or null when config
   * selects none: then nothing is built. `sync`: the store, Clock and log build() also hands it, so the GitHub forge
   * records its PR comments and labels and can poll.
   */
  async forge(
    github: GitHubApi, sync: { store: FactoryStore; clock: Clock; log: Logger; credentials?: GitHubCredentials } | null = null,
  ): Promise<Forge | null> {
    const name = this.loaded.plugins.forge;
    if (name === undefined) return null;
    const ctx = { ...this.base, github, ...sync };
    return createPlugin(this.loaded.registry, "forge", name, ctx);
  }
}
