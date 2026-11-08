// Worker component (RFC 0015 §7 Workers): the public API. Other components and the legacy code import only this
// file. The pool (`pool.ts`) runs the worker loops; the runner (`runner.ts`) claims runs and drives each through
// the ExecutionEngine; each run kind is a discovered folder under `runs/`.

export { Worker } from "./runner.js";
export {
  CountedKeepAwake, WORKERS_CLI_ACTOR, WORKERS_USAGE, WorkerPool, parseWorkersArgs, runWorkersCommand,
} from "./pool.js";
export {
  DIFF_CHECK_MS, HOST_SLEEP_MS, NETWORK_PAUSED_BY, NO_COMMITS_DETAIL, READ_TOOLS, TRUSTED_GIT_ENV, WARM_FAILED, WRITE_TOOLS,
  fenced, reviewComment, runCommits, testWorkerShare, toolsNamed, untrustedGitConfig,
  type LocalRoute, type WorkerDeps,
} from "./support.js";
