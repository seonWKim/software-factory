# Architecture

Four views of one system:
- the layers and their abstractions
- the control plane vs agent plane split
- what happens from startup through one work item
- how it scales horizontally

Details of each decision live in [`design.md`](design.md).

## 1. Layers

Every dependency points downward. Core code talks only to interfaces, never to a vendor or a concrete backend. Implementations are chosen once, at startup, from config (the composition root).

```mermaid
graph TB
  subgraph SURF["Surfaces"]
    direction LR
    GH["GitHub: issues, PRs, reviews"]
    SL["Slack (later)"]
    CLI["factory CLI"]
  end

  subgraph CORE["Core: factory logic, no vendor code"]
    direction LR
    subgraph CP["Control plane: deterministic, no LLM"]
      direction TB
      IN["Intake"]
      MG["Scheduler + leases"]
      RP["Reaper"]
      GT["Gate rules: tiers, dials, budgets"]
      PM["Post-merge watcher"]
    end
    subgraph AP["Agent plane: LLM roles"]
      direction TB
      TR["Triage"]
      IM["Implementer"]
      RV["Reviewer"]
      IMP["Improver (Phase 3)"]
    end
  end

  subgraph IF["Interfaces"]
    direction LR
    I1["FactoryStore"] --- I2["Sandbox"] --- I3["AgentRunner"] --- I4["LLMProvider"] --- I5["AuthProvider"]
    I6["SecretStore"] --- I7["SourceAdapter"] --- I8["CapabilitySearch"] --- I9["SharedStorage"]
  end

  subgraph IMPL["Implementations: chosen by config"]
    direction LR
    LOC["Local (now)"]
    CLD["Cloud / enterprise (later)"]
  end

  SURF --> CORE --> IF --> IMPL
```

| Interface | Local implementation (now) | Cloud / enterprise implementation (later) |
|---|---|---|
| `FactoryStore` | SQLite (single node only) | Postgres (required for more than one node) |
| `Sandbox` | `NoOpSandbox`: git worktree on the host | Docker → gVisor / Kata / Firecracker, hosted sandboxes |
| `AgentRunner` | `ClaudeCodeRunner`: `claude -p` | API-based runner |
| `LLMProvider` | Anthropic via the Claude Code CLI (subscription) | Anthropic API, Bedrock, Vertex, company ML gateway |
| `AuthProvider` | NoAuth | SSO / OIDC, GitHub permissions, policy engine |
| `SecretStore` | `.env` | Vault / cloud secret manager |
| `SourceAdapter` | GitHub issues via REST / `gh` | Slack, GitLab |
| `CapabilitySearch` | List everything | BM25, vector, hybrid |
| `SharedStorage` | Local filesystem | PV / PVC |

## 2. Control plane vs agent plane

This one distinction shapes everything else.

| | Control plane | Agent plane |
|---|---|---|
| What | Intake, scheduler, reaper, gate rules, post-merge watcher | Triage, implementer, reviewer, improver |
| Logic | Deterministic code: same input, same output | LLM judgment: can be wrong |
| Lifetime | Long-running | Ephemeral: one run per work item per stage |
| Where it runs | Controller process | Worker process, inside a `Sandbox` |
| State | Reads and writes the `FactoryStore` only | Holds nothing. Reads pointers, writes handoff rows and commits, then exits |
| Merge, lower a tier, grant access? | Enforces the rules for these | Never |

Agents propose. The control plane decides by rule or hands the decision to a human.

## 3. Startup and one work item

```mermaid
sequenceDiagram
  autonumber
  participant OP as Operator
  participant C as Controller
  participant ST as FactoryStore
  participant W as Worker
  participant AG as Agent run in Sandbox
  participant GH as GitHub
  participant H as Human

  OP->>C: factory controller
  OP->>W: factory worker
  C->>C: load config + .env, build implementations
  C->>ST: connect, run migrations
  C->>C: start loops: intake, scheduler, reaper, post-merge
  W->>W: load config, build Sandbox + AgentRunner

  GH-->>C: issue labeled factory (webhook or poll)
  C->>ST: insert work item NEW (unique per source id)
  C->>ST: enqueue run: triage
  W->>ST: claim run with lease
  W->>AG: Sandbox.create, AgentRunner.run(triage)
  AG->>ST: spec fields + handoff row
  AG->>GH: post spec comment
  W->>ST: run done, release lease
  C->>ST: READY, blocked_on human
  H->>GH: approve spec
  GH-->>C: approval
  C->>ST: blocked_on none, enqueue run: implement

  W->>ST: claim run with lease
  W->>AG: Sandbox.create(worktree + branch), run implementer
  loop every commit
    AG->>GH: push commit
    AG->>ST: handoff row
    W->>ST: heartbeat (renew lease)
  end
  AG->>GH: open PR
  W->>ST: run done
  C->>ST: REVIEW, enqueue run: review

  W->>ST: claim run with lease
  W->>AG: run reviewer (blind pass, then intent)
  AG->>GH: acceptance tests + verdict
  W->>ST: run done
  alt bug found
    C->>ST: RUNNING, loop_count + 1, enqueue implement
  else passed
    C->>ST: tier recheck, gate rule decides
    C->>H: request merge (tier above auto_merge_max_tier)
    H->>GH: merge, with verdict form
  end
  GH-->>C: merged / reverted
  C->>ST: CLOSED + post_merge events
```

The controller never runs an agent and the worker never decides a transition. They meet only in the store: the controller **enqueues runs**, workers **claim runs**.

## 4. Horizontal scalability

Designed in from day one, even though Phase 1 runs one controller and one worker on a laptop.

```mermaid
graph TB
  subgraph EXT["External"]
    GH["GitHub / Slack"]
    LLM["LLM provider or gateway"]
  end

  LB["Load balancer (webhooks)"]

  subgraph CTRL["Controllers: N replicas, stateless"]
    C1["controller 1"]
    C2["controller 2"]
  end

  subgraph WRK["Workers: M nodes, stateless"]
    W1["worker node 1: sandboxes + read-only shared pool"]
    W2["worker node 2: sandboxes + read-only shared pool"]
    W3["worker node M"]
  end

  ST[("FactoryStore: Postgres")]

  GH --> LB --> CTRL
  CTRL <--> ST
  WRK <--> ST
  WRK --> GH
  WRK --> LLM
```

Scale workers for throughput. Scale controllers for availability.

**Rules that make this safe**

| Rule | Why |
|---|---|
| Controllers and workers are stateless. All state is in `FactoryStore` (plus commits on GitHub) | Any replica can die or be added at any time |
| Every state transition is a conditional update: `UPDATE ... WHERE id = ? AND version = ?` | Two replicas acting on the same item: one wins, the other gets 0 rows and moves on |
| Work is pulled, not pushed: workers claim runs with `SELECT ... FOR UPDATE SKIP LOCKED` + a lease | Adding a worker adds capacity with no coordinator; a dead worker's lease expires and the run is reclaimed |
| Intake is idempotent: unique key on `(source_type, source_id)` | Several controllers polling, or a webhook delivered twice, create one work item |
| Periodic loops (reaper, post-merge, dial) are idempotent or take a short leader lease in the store | Running them on N replicas does no harm |
| A worker's worktree is disposable. The branch on GitHub plus handoff rows are the truth | A run resumes on any node, not only the one that started it |
| Shared limits live in the store: LLM concurrency, token budgets, per-repo run caps | N workers can't overrun a provider rate limit or a budget, because they count against the same rows |
| Webhooks are verified, acknowledged fast, and written to the store before any work | Retries from GitHub are safe; slow processing never times out a webhook |
| SQLite is local-only. More than one node requires the Postgres `FactoryStore` | SQLite has one writer on one machine; the interface makes the swap a config change |

**Scaling knobs:** workers per node (`max_concurrent_runs`), number of worker nodes, warm sandbox pool size, controller replicas, LLM concurrency cap.

## 5. Secret isolation

**Rule:** agents never read secrets. Only tools do. An agent sees a tool's *result*, never the credential the tool used.

```mermaid
graph LR
  subgraph HOST["Worker process (trusted)"]
    SS["SecretStore (.env now, vault later)"]
    TB["Tool broker: credentialed tools (GitHub, Slack, DB)"]
    SS --> TB
  end
  subgraph SBX["Sandbox (untrusted): agent run"]
    AG["Agent: model + Bash/file tools"]
  end
  AG -->|"tool call: name + args"| TB
  TB -->|"result only"| AG
  TB -->|"credential attached here"| EXT["GitHub / Slack / DB"]
```

**Guards (each one hard, layered so one failure isn't a leak):**

| # | Guard | Stops |
|---|---|---|
| G1 | Secrets are loaded only by the worker process via `SecretStore`. The agent process gets an **allowlisted** environment (no secrets), never the worker's env | `env`, `printenv`, `process.env` inside the agent |
| G2 | Credentialed actions (push, PR, comment, DB query) are tools served by a broker **outside** the sandbox, which attaches credentials | The agent needing a token at all |
| G3 | The sandbox's filesystem view excludes secret files: worktrees never contain `.env` (gitignored), and the secret file lives outside any path the sandbox mounts | `cat ~/…/.env`, path guessing |
| G4 | Harness-level deny rules on secret paths for the agent's file and shell tools | Defense in depth while G3 is weak (`NoOpSandbox`) |
| G5 | Egress scan: every agent output (commits, PR text, comments, handoff rows, logs) is checked for known secret values and secret patterns before it leaves; a hit fails the run | A leak that got past G1–G4 reaching GitHub or the store |
| G6 | Tests: a canary secret is planted; a test agent is told to find and print it; the run must fail to find it, or be stopped by G5 | Regressions in G1–G5 |

**With `NoOpSandbox` (Phase 1), G3 is weak:** the agent runs as the host user, so a secret file anywhere on the host is reachable by absolute path. Until a real sandbox exists, keep the secret file outside the project and home-relative guessable paths, and rely on G1, G2, G4, G5, G6. Moving to a container sandbox makes G3 hard.

**The agent harness's own credential** (the token `claude -p` needs to call the model) is the one secret the agent process must hold. It is passed to the harness only, scrubbed from the environment of the harness's tool subprocesses, and covered by G5.

### Harness controls for `ClaudeCodeRunner` (Claude Code docs, checked 2026-10-31)

The runner writes a per-run Claude Code settings file into the agent's run directory:

```jsonc
{
  "env": { "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB": "1" },          // G1: strip credentials from Bash, hooks, stdio MCP children
  "permissions": {
    "deny": ["Read(**/.env)", "Read(**/.env.*)", "Read(~/.config/software-factory/**)"],   // G4: file tools + recognized Bash file commands
    "blockReadsOutsideWorkingDirectories": true
  },
  "sandbox": {                                                   // G3 at OS level, even under NoOpSandbox
    "enabled": true,
    "filesystem": { "denyRead": ["~/.config/software-factory", "~/.ssh", "~/.aws"] },
    "credentials": { "envVars": [{ "name": "GITHUB_TOKEN", "mode": "deny" }, { "name": "GH_TOKEN", "mode": "deny" }] }
  }
}
```

What the docs say, and the gaps the canary test (G6) must cover:
- `Read(...)` deny rules cover the file tools and Bash commands Claude Code recognizes (`cat`, `head`, `tail`, `sed`, `tee`, redirections), **not** `grep -r` or scripts that open files themselves. OS-level `sandbox.filesystem.denyRead` covers Bash and its children but **not** the Read tool, so both are needed.
- `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` keeps the harness's own credential for model calls and strips credentials from subprocesses. `GITHUB_TOKEN` / `GH_TOKEN` are **not** stripped by it (hence the `credentials.envVars` deny, and G1 never passes them in). Whether `CLAUDE_CODE_OAUTH_TOKEN` is stripped is not stated explicitly: G6 checks it with `env` inside a run.
- Exact keys and semantics: verify against the installed Claude Code version when implementing (the subprocess scrub list changed in v2.1.251).
