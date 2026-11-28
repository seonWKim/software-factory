// Composition root: the only place that picks implementations and wires the factory. Reading factory.config.json
// lives in load-config.ts and config-values.ts, so code that only reads config does not load this file.
// Environment (local / cloud) is chosen here; core code never branches on it.

import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { availableParallelism, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type FactoryConfig, cliUserConfig, toolGrantsConfig } from "./core/config.js";
import type { ProjectRef } from "./core/project.js";
import { routineQueue, scheduledAction } from "./core/controller-deps.js";
import { agentAction } from "./controller/units/schedule/plugins/agent/agent-action.js";
import { buildAction } from "./controller/units/schedule/plugins/build/build-action.js";
import { checkPageAction } from "./controller/units/schedule/plugins/check-page/check-page-action.js";
import { summaryAction } from "./controller/units/schedule/plugins/summary/summary-action.js"; import { NO_OWNER_CHAT, summaryDeps } from "./core/summary.js";
import { feedbackActionWith } from "./controller/units/schedule/plugins/feedback/feedback-action.js";
import { nodeGrantDeps } from "./impl/schedule-action/routed-action.js";
import { improveAction } from "./controller/units/schedule/plugins/improve/improve-action.js";
import { dailyTriggerOn, enqueueImprove } from "./core/improver.js";
import { saveProject, saveProjectLabel } from "./core/project-labels.js";
import { errorText, type Logger } from "./core/log.js";
import type { CliEnvironment, CliIdentity } from "./core/local-cli.js";
import { canMergeLocal, forgeRoles } from "./core/local-merge.js";
import { StoredLearnedSettings } from "./core/learned-settings.js";
import type { UserId } from "./core/types.js";
import { gitHost, hostId } from "./runtime/host-id.js";
import { ControllerRole } from "./runtime/roles/controller-role.js";
import { SqlHookAudit, loadHooks, validateCase } from "./runtime/index.js";
import { skillFolderPath } from "./runtime/capabilities/capabilities.js";
import { type SkillStarter, STARTER_PROMPT, skillStarter } from "./core/skill-eval-starter.js";
import { PackCheckRunner } from "./runtime/hooks/pack-checks.js";
import { type HookDescriptor, UNCALLED_HOOK_POINTS } from "./shared/hook.js";
import { feedbackGrants } from "./core/schedule-grants.js";
import { type LearnedSettingsSource, LiveSettings, maxWorkers, workerCount } from "./core/settings.js";
import { settingsBase } from "./core/settings-base.js";
import { type LocalRoute, READ_TOOLS, WorkerPool } from "./worker/index.js";
import { type BrokerDeps, Plugins } from "./plugin-set.js";
import type { Clock } from "./interfaces/clock.js";
import type { EgressScanner } from "./interfaces/egress-scanner.js";
import type { GitHubApi } from "./interfaces/github-credentials.js";
import type { FactoryStore } from "./interfaces/factory-store.js";
import type { Forge } from "./interfaces/forge.js";
import type { Sandbox } from "./interfaces/sandbox.js";
import type { AuthAction, AuthDecision, AuthProvider } from "./interfaces/auth-provider.js";
import type { ToolBroker } from "./interfaces/tool-broker.js";
import type { SecretStore } from "./interfaces/secret-store.js";
import { CODE_VERSION_ENV, SUPERVISOR_STATUS_FILE, WORKER_INDEX_BASE_ENV } from "./interfaces/updater.js";
import { ProfileStore, startIdentity, type IdentityRuntime } from "./identity/index.js";
import { controllerServiceAuth, outboundServiceAuth } from "./impl/auth/audited-auth.js";
import { OwnerAuth } from "./core/authorize.js";
import { storeSql } from "./impl/store/sql/store-sql.js";
import type { RepoRef } from "./impl/github/github-client.js";
// The GitHub forge's descriptor: the one GitHub module a config with no GitHub plugin loads (descriptors only).
import { type RepoLookup, resolveProject } from "./impl/github/forge.plugin.js";
import { ConsoleLogger } from "./impl/log/console-logger.js";
import type { UiCommands } from "./ui/commands.js";
import { type UiSettings, configWriter, newCsrfToken, storeProjectResolver } from "./ui/settings-api.js";
import type { UiPauses } from "./ui/pause-api.js";
import { type UiTacit, uiTacit } from "./ui/rules-api.js";
import { baseEnv, runProcess } from "./impl/process/run-process.js";
import { LiveTacit } from "./runtime/live-tacit.js";
import { LiveCalendars } from "./calendar/index.js";
import { INTEGRATION_KINDS, createPlugin, selectedRunners, selectedSources } from "./plugins.js";
import { packChecks, packSkills } from "./packs/packs.js";
import { importedMcpRefusals, listRequestedMcpTools } from "./import/mcp-tool-lists.js";
import { startPackMcpServer } from "./impl/runner/pack-mcp-client.js";
import { type SandboxEnforcement, probeOsSandbox } from "./impl/runner/os-sandbox.js";
import { PackGuidance } from "./impl/capability/project-guidance.js";
import { LearnedRules, joinGuidance } from "./core/learned-rules.js";
import { checkToolchainEnv, codeVersion, readRestarts, uiCommandsActor, uiUserId, workerIndexBase } from "./config-values.js";
import { type Loaded, loadConfig, localProject, resolvedConfig } from "./load-config.js";
import { reviewReplay } from "./golden-replay.js";
import { brokerGuard, skillImproveWiring } from "./skill-evals.js";
import { holdSkillDraft, promoteSkillDraft, rejectSkillDraft, withHandOff } from "./core/skill-improve.js";
import { Cleaner, type CleanupStore, agentTempRoots, cleanupConfig, hostProcesses } from "./cleanup/index.js";
import { RUN_FOLDER } from "./setup-paths.js";
import { randomUUID } from "node:crypto"; import { CHAT_EVAL_QUESTIONS, chatEvalDaily, chatEvalSchedule } from "./core/chat-eval.js"; import { readFeatureMap } from "./api/feature-map.js"; import { REGISTRY } from "./api/index.js";

export { CODE_ROOT_ENV, CONFIG_ENV, WORKER_INDEX_BASE_ENV } from "./interfaces/updater.js";

/** The GitHub project key's resolution, for the CLI commands that resolve the key outside startup. */
export { resolveProject };

/** First wait between startup lookups while the configured repo's key is not known yet; it doubles up to the max. */
export const PROJECT_RETRY_MS = 30_000;
const PROJECT_RETRY_MAX_MS = 600_000;

/** What startupProject needs: the store holding the key, the forge's read of it, and where to log and wait. */
export interface StartupProjectDeps {
  store: Pick<FactoryStore, "getCursor" | "advanceCursor" | "listSettingOverrides" | "listWorkItems">;
  /** The configured repo's project as the forge reports it now (Forge.projectIdentity). */
  identify: () => Promise<ProjectRef>;
  repo: RepoRef;
  clock: Clock;
  log: Logger;
  /** Stops the wait for a first resolution (SIGTERM, a drain). */
  signal?: AbortSignal;
}

/**
 * The configured repo's project at startup (design 2026-11-07): GitHub is a sync plugin, so a start never waits
 * on it once the key is known. The stored key comes first; the returned `refreshed` is one background GitHub read
 * that stores the current label (a rename) and logs, never throws, when GitHub fails or is rate limited. Only a
 * store that has never had the key (a first start) asks GitHub before returning: a rate limit, an outage or a
 * network error is logged and retried, waiting PROJECT_RETRY_MS and doubling up to 10 minutes, until it resolves
 * or `signal` stops it. Every stored item, command and run carries the key, so before the first resolution there
 * is nothing local to process. A 401 or a 404 stops startup with the configured repo and the reason.
 */
export async function startupProject(d: StartupProjectDeps): Promise<{ project: ProjectRef; refreshed: Promise<void> }> {
  const known = await storeProjectResolver(d.store, d.repo)();
  if (known) {
    // A store written before the key cursor: found by its label, stored now so the next start reads it directly.
    await saveProject(d.store, d.repo, known);
    const refreshed = d.identify().then(
      async (now) => {
        if (now.key === known.key) {
          await saveProjectLabel(d.store, now);
          return;
        }
        await saveProject(d.store, d.repo, now);
        d.log.warn("GitHub reports another repository ID for the configured repo; the next start uses it", { project: now.label });
      },
    ).catch((err: unknown) => d.log.warn("GitHub unreachable at startup; using the stored project key", { project: known.label, error: errorText(err) }));
    return { project: known, refreshed };
  }
  for (let wait = PROJECT_RETRY_MS; ; wait = Math.min(wait * 2, PROJECT_RETRY_MAX_MS)) {
    try {
      const project = await d.identify();
      await saveProject(d.store, d.repo, project);
      return { project, refreshed: Promise.resolve() };
    } catch (err) {
      if ((err as { permanent?: unknown } | null)?.permanent === true) throw err; // retrying cannot fix it (bad credentials, no such repository)
      d.log.warn("the configured repo's project key is not stored yet and GitHub cannot resolve it; retrying", {
        repo: `${d.repo.owner}/${d.repo.name}`, retry_in_ms: wait, error: errorText(err),
      });
    }
    await d.clock.sleep(wait, d.signal);
  }
}

/** What projectAtStartup reads the key through: the selected forge, or a test's stand-in for its GitHub client. */
interface ProjectSource { forge: Forge | null; repoLookup?: RepoLookup | undefined }

/**
 * The configured repo's key at startup (design 08-plugins). No GitHub plugin selected: the local project, stored as
 * the configured repo's key (#350's cursor) with no forge call. A forge that names its repository
 * (Forge.projectIdentity): startupProject through it. A GitHub plugin but no such forge: the stored key, else the
 * local one, with no forge call. Never a GitHub client call here.
 */
async function projectAtStartup(loaded: Loaded, src: ProjectSource, d: Omit<StartupProjectDeps, "identify">): Promise<{ project: ProjectRef; refreshed: Promise<void> }> {
  const { forge, repoLookup } = src;
  const identify = repoLookup ? () => resolveProject(repoLookup, d.repo) : forge?.projectIdentity ? () => forge.projectIdentity!() : null;
  const solo = loaded.config.local_only === true;
  if (!solo && identify !== null) return startupProject({ ...d, identify });
  const project = (solo ? null : await storeProjectResolver(d.store, d.repo)()) ?? localProject(d.repo);
  await saveProject(d.store, d.repo, project);
  return { project, refreshed: Promise.resolve() };
}

/**
 * Shares GitHub's rate limit through the store from now on (design 05-sources, call budget): every process that
 * calls GitHub reads the last response any replica got, at most once per tick, and writes its own. With no GitHub
 * plugin selected there is no client, and no budget row is written.
 */
function shareGitHubBudget(loaded: Loaded, github: GitHubApi, store: FactoryStore, config: FactoryConfig): void {
  if (loaded.config.local_only !== true) github.shareBudget({ store, project: config.project.key, refresh_ms: config.tick_ms });
}

/** This host's cleanup of closed items' leftovers (design 08-cleanup): the controller's step and `factory cleanup`. */
export async function hostCleaner(loaded: Loaded, store: CleanupStore, clock: Clock): Promise<Cleaner> {
  const { repo, branch_prefix } = loaded.config;
  // The real path: a process's working folder, as the host reports it, has no symlink in it.
  const worktreesDir = await realpath(loaded.worktreesDir).catch(() => loaded.worktreesDir);
  return new Cleaner({
    store, clock, config: cleanupConfig(loaded.file), host: hostId(loaded.stateDir), log: new ConsoleLogger(clock, "cleanup"),
    env: { repo: repo.path, worktreesDir, runFolder: RUN_FOLDER, branchPrefix: branch_prefix, baseBranch: repo.base_branch, run: runProcess, processes: hostProcesses(runProcess, repo.path), agentTempRoots: agentTempRoots() },
  });
}

export interface Built {
  loaded: Loaded;
  clock: Clock;
  store: FactoryStore;
  secrets: SecretStore;
  /** The configured repo, from the store, or from GitHub on a first start (startupProject). */
  project: ProjectRef;
  controller: ControllerRole;
  /** `config.max_workers` worker slots, `workers` of them claiming; `run(signal)` runs them all. */
  worker: WorkerPool;
  close(): Promise<void>;
}

export async function build(
  loaded: Loaded,
  opts: { clock?: Clock; extraScanValues?: string[]; workerIndexBase?: number; repoLookup?: RepoLookup; signal?: AbortSignal } = {},
): Promise<Built> {
  const { stateDir, registry, plugins: sel } = loaded;
  await mkdir(join(stateDir, "db"), { recursive: true, mode: 0o700 });
  const p = new Plugins(loaded, opts);
  const base = p.base;
  const clock = opts.clock ?? (await p.clock());
  const secrets = await p.secrets();
  const store = await p.store(secrets, clock);
  await store.migrate();

  const scanner = await p.scanner(secrets);
  // G1 on the toolchain env values, by the configured scanner, before anything is built that could start an agent.
  await checkToolchainEnv(loaded.config.toolchain, scanner);
  // The one forge client of this build: every plugin that calls the forge gets it; only the broker and the forge (its
  // writes are outbound's, RFC 0015 M7) get credentials.
  const { credentials, api: github } = await p.githubAccess({ secrets, clock });
  const sandbox = await p.sandbox();

  // One adapter per listed source; the controller routes each item to the one of its source type.
  const sources = [];
  const sourceLog = new ConsoleLogger(clock, "source");
  for (const name of selectedSources(sel)) {
    sources.push(await createPlugin(registry, "source", name, { ...base, github, store, secrets, scanner, log: sourceLog, clock }));
  }
  // PR events, facts, comments and status (issue #273), else null; with no forge, the local forge reads links (forgeRoles).
  const selected = await p.forge(github, { store, clock, log: new ConsoleLogger(clock, "forge"), credentials });
  const { forge, links } = forgeRoles(selected, selected ?? (await createPlugin(registry, "forge", "local", { ...base, github })));
  // Identity (RFC 0015 §8, M9): service and run passports, and the audit of every authorize decision.
  const identity = await startProcessIdentity(loaded, store, clock);
  // Every person's command, whatever its origin, by the one owner check, one authz_audit row per decision (passport `none`).
  const auth = new OwnerAuth(store);
  // Suggests a command for a plain-language comment; never changes state (design §4). The worker pool's improve
  // runs draft a cause and fix per failure group through it, with no tools (design §7).
  const llm = await p.llm(secrets);
  // The broker before the runner: the runner exposes granted broker tools through it (`tool_grants`).
  const brokerDeps: BrokerDeps = { github, credentials, secrets, store, scanner, clock };
  const broker = await createPlugin(registry, "broker", sel.broker, { ...base, ...brokerDeps });
  // Checked here, not in loadConfig: the broker's tool list comes from its plugin. Read-only tools only.
  const tool_grants = toolGrantsConfig(loaded.file.tool_grants, broker, sel.broker);
  // Local items take the local broker and sandbox, by their source type, never the selected forge's (design 05-sources).
  const unguardedLocal = await p.localRoute({ broker, sandbox }, brokerDeps);
  // G2 with run passports and pack tool approvals (#592): every broker the worker pool or an agent's granted tools reach checks both.
  const { guard, passports } = brokerGuard(loaded, { store, secrets, identity: identity.passports, tool_grants });
  const local = { ...unguardedLocal, broker: guard(unguardedLocal.broker) };
  const guarded = guard(broker);
  const grants = feedbackGrants({ store, deps: nodeGrantDeps, passports, base: { tools: READ_TOOLS, repo: resolve(loaded.config.repo.path), base_ref: loaded.config.repo.base_branch } });
  const runner = await p.runner(sandbox, secrets, { broker: guard(grants.broker(broker)), scanner }); // a feedback schedule's shell grant reaches its run through the tool bridge, inside G2
  const granted = [...new Set(Object.values(tool_grants ?? {}).flat())];
  if (granted.length > 0 && !runner.exposes_tools) {
    throw new Error(`tool_grants grants ${granted.join(", ")}, but the ${selectedRunners(sel).join(", ")} agent runner cannot expose broker tools; remove tool_grants or pick a runner that can`);
  }
  const storage = await createPlugin(registry, "storage", sel.storage, base);
  const awake = await createPlugin(registry, "awake", sel.awake, { ...base, clock });
  // list-all lists the packs' skills (design 11-packs.md); with none it finds nothing and the prompt gets no index.
  const capability = await createPlugin(registry, "capability", sel.capability, { ...base, capabilities: packSkills(loaded.packs) });
  // The network pause's probe (design §5 Restarts): only the endpoints of the plugins selected above.
  const network_probe = await createPlugin(registry, "network_probe", sel.network_probe, base);
  // The bus and the tick generators the roles run on (RFC 0015 §5, design 10-event-driven).
  const bus = await createPlugin(registry, "bus", sel.bus, base);
  const ticks = await createPlugin(registry, "ticks", sel.ticks, base);
  const { holder: tacit, handOff: tacitHandOff } = await withHandOff((build) => LiveTacit.start(sel.tacit, build, new ConsoleLogger(clock, "tacit")), (name) => createPlugin(registry, "tacit", name, base));
  const calendars = new LiveCalendars(async (name) => createPlugin(registry, "calendar", name, { ...base, secrets: await new Plugins({ ...loaded, plugins: { ...sel, calendars: [name] } }).secrets(), clock }), new ConsoleLogger(clock, "calendar"));
  // The worker's ExecutionEngine (RFC 0015 §7): one per worker loop, built by the pool.
  const engines = await createPlugin(registry, "engine", sel.engine, { ...base, store });
  // Startup resolution (design 2026-11-07), after every plugin check so a bad selection is reported first: the
  // project key every write uses, from the store; GitHub refreshes the label in the background (a rename). With
  // no GitHub plugin: the local project key, and no GitHub call.
  const { project, refreshed } = await projectAtStartup(loaded, { forge, repoLookup: opts.repoLookup }, {
    store, repo: base.repo, clock, log: new ConsoleLogger(clock, "startup"), ...(opts.signal ? { signal: opts.signal } : {}),
  });
  const config: FactoryConfig = { ...resolvedConfig(loaded.config, project), ...(tool_grants ? { tool_grants } : {}) };
  // What a fired schedule occurrence runs (design 08-schedules): none unless `plugins.schedule_action` names one; its routes are the schedule unit's action folders.
  const routes = { build: buildAction, agent: agentAction, feedback: feedbackActionWith(grants.handOut), improve: improveAction((slot) => enqueueImprove({ store, clock }, project.key, { slot })), check_page: checkPageAction(routineQueue(store, project.key)), summary: summaryAction(summaryDeps({ store, scanner, times: () => settings.values(), post: NO_OWNER_CHAT })) }, actionCtx = { ...base, store, runner: grants.runner(runner, project.key), sandbox, scanner, tools: READ_TOOLS, project: project.key, routes };
  const schedule_action = sel.schedule_action === undefined ? undefined : scheduledAction(store, await createPlugin(registry, "schedule_action", sel.schedule_action, actionCtx), new ConsoleLogger(clock, "schedule"), project.key);
  // The pack checks `hooks` names (design §4, issue #494), refused here when bad; its other names are `*.hook.ts`.
  const checks = packChecks(loaded.packs, config.hooks ?? [], { toolHooks: runner.supports_tool_hooks === true });
  await checkEnabledHooks((config.hooks ?? []).filter((n) => !checks.some((c) => c.name === n)));
  shareGitHubBudget(loaded, github, store, config);

  // Runtime overrides (design 2026-11-03) and learned values (08-settings): one cache of file values, stored overrides
  // and learned values, shared by the controller and the worker pool, refreshed each tick. Project blocks: by project key.
  const learned = new StoredLearnedSettings(store, new ConsoleLogger(clock, "settings"));
  const settings = new LiveSettings({
    config, base: { ...settingsBase(loaded), layers: config.settings }, source: store, learned,
    log: new ConsoleLogger(clock, "settings"), integrations: [tacit], calendar: calendars, // the live `calendar` list (design 08-settings)
  });
  await settings.refresh();

  // The model credential check the workers claim by and the daily chat eval run waits on (design 05-restart-pauses).
  const credentialCheck = modelCredentialCheck(loaded, secrets);
  const controller = new ControllerRole({
    store,
    sources, forge, links,
    auth,
    service_auth: controllerServiceAuth(identity.passports),
    outbound_auth: outboundServiceAuth(identity.passports),
    clock,
    config,
    log: new ConsoleLogger(clock, "controller"),
    scanner,
    llm,
    calendar: calendars.feeds, // synced every 5 minutes (design 02-tasks); [] unless the `calendar` setting lists some
    ...(schedule_action ? { schedule_action } : {}), // absent: the schedule unit claims nothing
    network_probe, bus, ticks, tacit, // tacit: the owner's ledger (#570), whose capture CLI outbound runs; no agent run gets it
    // Owner of a stream source's listener lease while this process holds it (docs/architecture.md, Intake).
    replica_id: `${hostname()}:${process.pid}`,
    // The factory repo's git writes under this machine's stable host id; a SQLite store (solo) flushes every host's.
    git_host: gitHost(stateDir, sel.store),
    settings, learned,
    // The worker pool's sandbox: the controller's local merge check fetches and checks through it (design §5).
    sandbox, coordinator: (await import("./coordinator/wire.js")).coordinatorWiring({ store, clock, config, owner: `${hostname()}:${process.pid}`, codeRoot: loaded.codeRoot, runner, sandbox, scanner, storage, tools: READ_TOOLS, log: new ConsoleLogger(clock, "coordinator") }), repo_entries: async (names) => (await Promise.all(names.map((n) => stat(join(config.repo.path, n)).then(() => [n], () => [])))).flat(), // the merge reply's run hint
    // The alarm step's restart count (design 05-alarms): this host's supervisor status file.
    restarts: () => readRestarts(join(loaded.stateDir, SUPERVISOR_STATUS_FILE)),
    // This process's GitHub budget, stored after each poll for the status page (design §5, GitHub call budget).
    // With no GitHub plugin selected (Local startup) there is no GitHub client and no budget to record.
    // The shared budget is read before each tick's optional reads, at most once per tick.
    ...(loaded.config.local_only === true ? {} : { github_budget: () => github.status(), refresh_forge_budget: () => github.refreshSharedBudget() }),
    // The red-main check after an automatic merge (design 03-risk) runs the checks with the worker's base env.
    check_env: baseEnv(),
    cleanup: await hostCleaner(loaded, store, clock), ...(chatEvalDaily(loaded.file) && { chat_eval: chatEvalSchedule(store, { llm, judge: llm, read: (p) => readFeatureMap(REGISTRY, p), scanner, clock, newId: randomUUID }, () => readFile(join(loaded.codeRoot, CHAT_EVAL_QUESTIONS), "utf8"), credentialPresence(credentialCheck).modelCredential) }), // closed items' leftovers (design 08-cleanup); the daily chat eval run with chat_eval.schedule "daily" (design 04-chat-agent), skipped while no model credential is saved
  });

  const id_prefix = `${hostname()}:${process.pid}`;
  const worker = new WorkerPool({
    id_prefix,
    // A run's push and PR go to this machine's git destination (`git:<host id>:<branch>`), which its controller flushes.
    host: hostId(stateDir),
    // The supervisor's block for this child (git-worktree updater); unset: 0.
    index_base: opts.workerIndexBase ?? workerIndexBase(process.env[WORKER_INDEX_BASE_ENV]),
    // The revision the supervisor built this child from, stamped on each run (`worker_runs.code_version`); unset: dev.
    ...codeVersion(process.env[CODE_VERSION_ENV]),
    store, sandbox, runner,
    broker: guarded, local, passports,
    scanner, storage, llm,
    ...credentialPresence(credentialCheck),
    clock, config,
    prompts: loaded.prompts,
    log: new ConsoleLogger(clock, "worker"),
    toolEnv: baseEnv(), host_exec: runProcess, // the restart run's command, on the host in the base checkout (design 04-gate-commands)
    install_cache: join(stateDir, "run-deps"), // cloned node_modules per lock file; the updater's deps/ is its own (design 05-sandbox)
    // Split over the runs running on this host at each claim as SF_TEST_WORKERS, so parallel test runs do not each take every CPU.
    cpus: availableParallelism(),
    models: { table: loaded.model_by, names: loaded.models },
    reviewReplay: reviewReplay({ sandbox, runner, scanner, clock, models: { table: loaded.model_by } }), // the improve run's golden replay (design 07)
    skillImprove: skillImproveWiring(store, loaded, { sandbox, runner, llm, scanner, tools: { broker: guarded, passports, project: project.key } }), tacit: tacitHandOff, // skill drafts, undefined without capabilities.skill_folders, and their hand-off to the owner's ledger (design 07)
    awake, capability, guidance: joinGuidance([new PackGuidance(loaded.packs), new LearnedRules(tacit)]), // packs' rules, then promoted rules (design 07)
    settings, learned,
    engines,
    ticks,
    pack_checks: new PackCheckRunner(checks, { sandbox, audit: new SqlHookAudit(storeSql(store)), now: () => clock.now().toISOString() }),
    // A run's PR comment is a thread entry on this ref; outbound posts it (RFC 0015 M7).
    ...(forge ? { prRef: (pr: number) => forge.prRef(pr) } : {}),
    // Imported MCP servers (design 11-plugin-import): never started for a run (owner answer 1); an approved one's
    // tools are listed here, in the worker, once per request, with an empty env and no credential (owner answer 3).
    imported_mcp_refusals: (servers) => importedMcpRefusals(storeSql(store), servers),
    list_mcp_tools: () => listRequestedMcpTools({ db: storeSql(store), now: () => clock.now().toISOString(), by: id_prefix, start: startPackMcpServer }),
  });

  return { loaded, clock, store, secrets, project, controller, worker, close: () => refreshed.then(() => identity.stop()).then(() => store.close()) };
}

/**
 * The model credential check (design §5 Restarts, setup state): doctor's check of the "model credential" group (the
 * `oneOf` label of the declarations) that every selected runner declares, read from the secret store at each call;
 * a store that cannot be read counts as missing. Resolves to doctor's line when missing, else null. Null when a
 * selected runner declares no such group: it reads no model credential. Presence only: no value leaves the store.
 */
export function modelCredentialCheck(loaded: Pick<Loaded, "registry" | "plugins">, secrets: SecretStore): (() => Promise<string | null>) | null {
  const declared = modelCredentialSecrets(loaded);
  if (declared === null) return null;
  const readable: SecretStore = { get: (name) => secrets.get(name).catch(() => null), valuesForScan: () => secrets.valuesForScan() };
  return async () => {
    const { secretChecks } = await import("./setup.js");
    return (await secretChecks(declared, readable)).find((c) => !c.ok)?.msg ?? null;
  };
}

/**
 * The "model credential" group every selected runner declares, each name once in declaration order; null when a
 * selected runner declares none (it reads no model credential). The worker's check and the dashboard's dialog read it.
 */
function modelCredentialSecrets(loaded: Pick<Loaded, "registry" | "plugins">) {
  const groups = selectedRunners(loaded.plugins).map((n) => (loaded.registry.runner.secrets[n] ?? []).filter((d) => d.oneOf === "model credential"));
  if (groups.length === 0 || groups.some((g) => g.length === 0)) return null;
  return [...new Map(groups.flat().map((d) => [d.name, d])).values()];
}

/**
 * The dashboard's Add model credential dialog (design 09-status-page): the declared names, each value written by the
 * setup writer `npm run setup` uses, into the secret file, made (folder 700, file 600) when absent. Undefined when no
 * selected runner reads a model credential.
 */
export function modelCredentialDialog(loaded: Pick<Loaded, "registry" | "plugins" | "secretsFile">): UiSettings["modelCredential"] {
  const declared = modelCredentialSecrets(loaded);
  if (declared === null) return undefined;
  return {
    secrets: declared.map((d) => d.name),
    save: async (values) => {
      const { setSecret } = await import("./setup.js");
      const file = loaded.secretsFile;
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(file, "", { flag: "a", mode: 0o600 });
      for (const { name } of declared) {
        const v = values.get(name);
        if (v !== undefined) await setSecret(file, name, v);
      }
    },
  };
}

/** WorkerDeps.modelCredential from a modelCredentialCheck; none when it is null. */
const credentialPresence = (check: (() => Promise<string | null>) | null) => (check ? { modelCredential: async () => (await check()) === null } : {});

/** This process's Identity on the store's database, its key in the state folder (denied to agents). */
export async function startProcessIdentity(loaded: Loaded, store: FactoryStore, clock: Clock): Promise<IdentityRuntime> {
  const log = new ConsoleLogger(clock, "identity");
  return startIdentity({
    db: storeSql(store),
    stateDir: loaded.stateDir,
    onError: (schedule, err) => log.error("identity tick failed", { step: schedule, error: errorText(err) }),
  });
}

/** `workers` from factory.config.json: absent means 1, otherwise an integer of 0 or more or startup fails. */
export { dailyTriggerOn, maxWorkers, workerCount }; // dailyTriggerOn: setup's Daily improve run schedule


/**
 * Every enabled hook name must be a discovered `*.hook.ts` at a point the factory calls: a typo, or a point no
 * caller runs yet, would otherwise leave the owner's check off without a word.
 */
export async function checkEnabledHooks(enabled: readonly string[], discovered?: readonly HookDescriptor[]): Promise<void> {
  if (enabled.length === 0) return;
  const known = new Map((discovered ?? (await loadHooks()).map((h) => h.descriptor)).map((h) => [h.name, h]));
  const missing = enabled.filter((n) => !known.has(n));
  if (missing.length > 0) throw new Error(`hooks: no discovered hook named ${missing.join(", ")}`);
  const unwired = enabled.filter((n) => UNCALLED_HOOK_POINTS.includes(known.get(n)!.point));
  if (unwired.length > 0) {
    throw new Error(`hooks: ${unwired.map((n) => `${n} (${known.get(n)!.point})`).join(", ")}: that point is not wired yet, so the hook would never run; remove it from hooks`);
  }
}

export interface UiParts {
  clock: Clock;
  store: FactoryStore;
  scanner: EgressScanner;
  /** The Settings page's write path (design §8, issue #236): the config base, repo, actor, store-only resolver, CSRF token. */
  settings: UiSettings;
  /** The item commands route (POST /api/v1/items/:id/commands, issue #227): its actor and the per-process token. */
  commands: UiCommands;
  /** The "Resume now" route (design §5 Restarts, issue #291): the page's factory user, the owner check, the CSRF token. */
  pauses: UiPauses;
  displayNames: (user_ids: readonly string[]) => Promise<ReadonlyMap<string, string>>; // by user id from Identity's identity_profiles (M9), only to show
  tacit: UiTacit; // the Rules page's ledger, switched by the `integrations` setting before each Rules request (design 08-settings)
  migrate: import("./ui/migrate-api.js").UiMigrate; // Migrate now, Start and Restart now (design 08-self-update): state dir, clock, run_timeout_ms, steps
  changes: import("./ui/changes.js").UiChanges | undefined; // the sandbox's readChanges on repo.path and its base: the Changes tab and Re-check (design 09-dashboard-item)
  skillImprove: import("./ui/deps.js").UiSkillImprove; // a skill draft's verdicts and Promote's wiring (design 09-dashboard-rules-waiting)
  starter: SkillStarter; // Draft starter cases on the Evals card: the Model plugin, prompts/skill-starter.md and the skill's SKILL.md (design 07-self-improvement)
  close(): Promise<void>;
}

/**
 * What the status page needs and nothing more: no controller, worker, source or runner, and no forge client.
 * Built through Plugins (the configured store, secrets and egress scanner). The secret store is loaded only because a store plugin may
 * declare secrets and the scanner needs the known secret values; neither reaches the page. The Settings page finds the configured repo's
 * project key from the stored project label (storeProjectResolver), so the UI process never calls the forge or reads a forge credential.
 * `identity` is the CLI identity main.ts resolves (cliIdentity); its user is the Settings writer, also of file-only keys (configWriter).
 * The CSRF token is made here, per process, and kept only in memory. The commands route acts as uiCommandsActor says and takes the same
 * token. The pause route's owner check uses the auth plugin over the local grants only, with a client that makes no forge call.
 */
export async function buildUiParts(loaded: Loaded, opts: { identity: CliIdentity }): Promise<UiParts> {
  await mkdir(join(loaded.stateDir, "db"), { recursive: true, mode: 0o700 });
  const p = new Plugins(loaded), clock = await p.clock();
  const secrets = await p.secrets(), store = await p.store(secrets, clock);
  await store.migrate();
  const scanner = await p.scanner(secrets);
  const { owner, name } = loaded.config.repo, token = newCsrfToken();
  const settings: UiSettings = {
    base: settingsBase(loaded), repo: { owner, name }, actor: opts.identity.user, resolveProject: storeProjectResolver(store, { owner, name }), csrfToken: token,
    integrations: INTEGRATION_KINDS.map((kind) => ({ kind, interface: loaded.registry[kind].interface, configured: String(loaded.plugins[kind]) })),
  };
  // The owner check for "Resume now", approve_tool and the page's command checks (approve_spec, approve_merge), with no
  // forge call. Each command decision is audited (passport `none`); a page's read-only check only when refused (`check`).
  const identity = await startProcessIdentity(loaded, store, clock);
  const auth = new OwnerAuth(store);
  const onProject = async (user_id: UserId, action: AuthAction, readOnly = false): Promise<AuthDecision> => {
    const project = await settings.resolveProject();
    if (!project) return { allow: false, reason: "no project is stored yet" };
    return auth[readOnly ? "check" : "authorize"]({ user_id }, action, { kind: "project", id: project.key });
  };
  // One token per process for every write route; held only in memory, never written to a file, the store or a log.
  // The UI server, loaded here only: through setup.ts it reaches GitHub modules a solo start must not load.
  const who = uiCommandsActor(uiUserId(loaded.file.ui), opts.identity, (await import("./ui/server.js")).BIND);
  // The Merge button's facts (design §9): a forge selected, a sandbox that merges locally (built only to ask, and to read changes).
  const sbx = await p.sandbox(), changes = sbx.readChanges && ((spec: Parameters<import("./ui/changes.js").UiChanges>[0]) => sbx.readChanges!({ repo: loaded.config.repo.path, base_ref: loaded.config.repo.base_branch, ...spec }));
  const commands: UiCommands = {
    ...who, token, forge: loaded.plugins.forge !== undefined, localMerge: canMergeLocal(sbx), changeName: (ref) => `PR #${ref}`, restart: loaded.config.repo.restart_command !== undefined,
    allowed: (action) => (who.actor === null ? Promise.resolve({ allow: false, reason: "no_actor" }) : onProject(who.actor, action, true)),
  };
  // The mode switch, the auto-merge tier and a loosening change need approve_merge on the project (design 08-settings), as the Merge button.
  settings.mayApproveMerge = async () => refusalOf(await onProject(opts.identity.user, "approve_merge"));
  settings.sandbox = () => sandboxEnforcement(loaded); // `mode auto` needs the OS sandbox, as from the CLI (design 05-sandbox.md)
  settings.editFile = configWriter({ loaded, store, sandbox: sbx, now: () => clock.now().toISOString(), actor: opts.identity.user, loadConfig, project: async () => (await settings.resolveProject())?.key ?? null });
  settings.calendar = (await import("./ui/calendar-api.js")).uiCalendar(loaded, {
    store, actor: settings.actor, clock, base: settings.base, connect: async (r) => (await import("./setup.js")).connectCalendar(r),
  }); // its Calendar section
  const modelCredential = modelCredentialDialog(loaded);
  if (modelCredential) settings.modelCredential = modelCredential; // the Add model credential dialog (Needs you, Failures)
  const llm = await p.llm(secrets).catch(() => null), wiring = llm ? await p.runner(sbx, secrets).then((runner) => skillImproveWiring(store, loaded, { sandbox: sbx, runner, llm, scanner }), () => undefined) : undefined;
  const starter = skillStarter({ llm, scanner, validate: validateCase, prompt: () => readFile(join(loaded.codeRoot, STARTER_PROMPT), "utf8").catch(() => null), readSkill: (ref) => readFile(join(skillFolderPath(ref, loaded.root), "SKILL.md"), "utf8").catch(() => null) });
  settings.ask = { llm, log: new ConsoleLogger(clock, "ask") }; // the Data page's Ask: the Model plugin, null when it cannot be built; wiring: Promote's re-run, none without capabilities.skill_folders
  const cliUser = cliUserConfig(loaded.file);
  const pauses: UiPauses = {
    // A local account linked to a factory user first, else `cli_user`: an ID, never a display name.
    principal: async () => (await auth.resolve({ provider: "local", subject: opts.identity.user.replace(/^local:/, "") }))?.user_id ?? cliUser,
    authorize: (user_id) => onProject(user_id, "approve_spec"),
    auth, // approve_tool for the pack approvals route (design 11-packs)
    csrfToken: token,
    log: new ConsoleLogger(clock, "ui"),
  };
  const profiles = new ProfileStore(storeSql(store)), displayNames = (ids: readonly string[]) => profiles.displayNames(ids);
  const tacit = await uiTacit(loaded.plugins.tacit, (n) => createPlugin(loaded.registry, "tacit", n, p.base), { config: loaded.config, base: settingsBase(loaded), source: store, log: new ConsoleLogger(clock, "tacit") });
  const migrate = (await import("./ui/migrate-api.js")).uiMigrate({ stateDir: loaded.stateDir, clock, runTimeoutMs: loaded.config.run_timeout_ms, githubApi: () => p.githubApi(), resolveProject }); // its GitHub client only for owner/name rows
  return { clock, store, scanner, settings, commands, pauses, displayNames, tacit, migrate, changes, skillImprove: { hold: holdSkillDraft, reject: rejectSkillDraft, promote: promoteSkillDraft, wiring }, starter, close: () => identity.stop().then(() => store.close()) };
}

const refusalOf = (d: AuthDecision): string | null => (d.allow ? null : d.reason);

/** Whether reads, writes and network are OS-enforced for the selected runners (doctor's probe), asked before `mode` becomes auto. */
export function sandboxEnforcement(loaded: Pick<Loaded, "plugins">): Promise<SandboxEnforcement> {
  return probeOsSandbox({ runners: selectedRunners(loaded.plugins) });
}

/** The owner check, with no forge call: how a CLI command is authorized (approve_tool, `factory settings`, `factory resume`). */
export async function localAuth(_loaded: Loaded, store: FactoryStore): Promise<AuthProvider> {
  return new OwnerAuth(store);
}

/**
 * The owner check of every CLI command that asks one (approve_merge for a `factory settings` or `mode` change, design 08-settings;
 * approve_spec for the sentence form, `factory resume` and `factory workers`): `user` on the configured project, no forge call.
 */
export function ownerRefusal(loaded: Loaded, store: FactoryStore, user: UserId, action: AuthAction): () => Promise<string | null> {
  const repo = loaded.config.repo;
  return async () => {
    const project = (await storeProjectResolver(store, repo)()) ?? (loaded.config.local_only ? localProject(repo) : null);
    if (!project) return "no project key is stored yet; start the factory once first";
    return refusalOf(await (await localAuth(loaded, store)).authorize({ user_id: user }, action, { kind: "project", id: project.key }));
  };
}

export type { CliEnvironment, CliIdentity, FactoryStore }; // for the CLI component (src/cli/command.ts)
export { writeRoutine, type Routine, type RoutineFields, type RoutineWrite } from "./core/check-page.js"; // `factory routine`

/** What `factory session` needs (design §5, 2026-11-01): no controller, worker, source or agent runner. `local` and `learned` as the worker pool's (Plugins.localRoute; 08-settings). */
export interface SessionParts {
  clock: Clock; store: FactoryStore; scanner: EgressScanner; sandbox: Sandbox; broker: ToolBroker; auth: AuthProvider; github: GitHubApi; config: FactoryConfig;
  local: LocalRoute; learned: LearnedSettingsSource;
  close(): Promise<void>;
}

/** build()'s parts a session uses, through the same registry; the broker is its only push and PR path. Live settings. */
export async function buildSessionParts(loaded: Loaded): Promise<SessionParts> {
  const { stateDir, registry, plugins: sel } = loaded;
  await mkdir(join(stateDir, "db"), { recursive: true, mode: 0o700 });
  const p = new Plugins(loaded);
  const [base, clock, secrets] = [p.base, await p.clock(), await p.secrets()];
  const store = await p.store(secrets, clock);
  await store.migrate();
  const [scanner, { credentials, api: github }, sandbox] = [await p.scanner(secrets), await p.githubAccess({ secrets, clock }), await p.sandbox()];
  const auth = new OwnerAuth(store);
  const brokerDeps: BrokerDeps = { github, credentials, secrets, store, scanner, clock };
  const broker = await createPlugin(registry, "broker", sel.broker, { ...base, ...brokerDeps });
  const local = await p.localRoute({ broker, sandbox }, brokerDeps);
  const forge = await p.forge(github);
  const { project, refreshed } = await projectAtStartup(loaded, { forge }, { store, repo: base.repo, clock, log: new ConsoleLogger(clock, "startup") });
  const config = resolvedConfig(loaded.config, project);
  shareGitHubBudget(loaded, github, store, config);
  const log = new ConsoleLogger(clock, "settings"), learned = new StoredLearnedSettings(store, log);
  const settings = new LiveSettings({ config, base: { ...settingsBase(loaded), layers: config.settings }, source: store, learned, log });
  await settings.refresh();
  return { clock, store, scanner, sandbox, broker, local, auth, github, learned, config: settings.config(), close: () => refreshed.then(() => store.close()) };
}

/**
 * The configured store for `factory stats`, and nothing else. Unlike build() and buildUiParts() it never
 * calls migrate(): stats writes nothing, not even a schema change. The secret store is loaded only because a store plugin may declare secrets.
 */
export async function buildStatsStore(loaded: Loaded): Promise<FactoryStore> {
  const p = new Plugins(loaded);
  const clock = await p.clock();
  return p.store(await p.secrets(), clock);
}

export { Plugins } from "./plugin-set.js";
export { type CleanupStore, reportLines as cleanupReport } from "./cleanup/index.js";
export { settingsBase } from "./core/settings-base.js"; export { addSchedule } from "./core/schedule.js"; // addSchedule: setup's Daily improve run
export { writeSkillVerdict } from "./ui/rules-api.js"; // `factory improve skill`: the Rules page's skill verdict
// Config reading moved to load-config.ts and config-values.ts (RFC 0023 step 2e); re-exported for the code that also wires.
export {
  CHECK_COMMANDS_PLACEHOLDER, cliConfig, CONFIG_FILE, type FileConfig, fillPrompt, FORGE_PLACEHOLDER, loadConfig, type Loaded, localProject, resolvedConfig, selectsGitHub, SPLIT_PLACEHOLDERS, type StoreConfig, TOOLCHAIN_PLACEHOLDER, UI_CHECK_PLACEHOLDER, withForgeDefault,
} from "./load-config.js";
export {
  agentStopChecks, alarmConfig, argvConfig, checkCommandsConfig, checkToolchainEnv, codeVersion, DEFAULT_UI_PORT, hookNames, isLoopback, MERGE_QUEUE_DEPTH_MAX, mergeQueueDepth, readRestarts, retryConfig, stallConfig, STATS_MIN_SAMPLE_DEFAULT, statsConfig, testCommand, toolchainConfig, uiCommandsActor, uiPort, uiUserId, workerIndexBase,
} from "./config-values.js";
