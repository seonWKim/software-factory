// The coordinator's wiring (design 05-coordinator): what compose hands the controller as `coordinator`. The lease is the
// sync lease row `coordinator` (src/core/lease.ts), held for one cycle: it outlasts one agent call (run_timeout_ms plus
// a margin), so a replica that stopped mid-cycle is taken over once that much time has passed.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { StoreLease, syncLeaseOps } from "../core/lease.js";
import type { Logger } from "../core/log.js";
import type { FactoryConfig } from "../core/config.js";
import type { FactoryStore } from "../interfaces/factory-store.js";
import { storeSql } from "../impl/store/sql/store-sql.js";
import { type AgentDeps, COORDINATOR_PROMPT, coordinatorAgent } from "./agent.js";
import { COORDINATOR_LEASE, Coordinator, type CoordinatorPorts } from "./cycle.js";
import { CoordinatorStore } from "./store.js";

/** How long the cycle's lease outlasts one agent call. */
export const LEASE_MARGIN_MS = 5 * 60_000;

export interface WiringDeps extends Omit<AgentDeps, "prompt" | "config"> {
  store: FactoryStore;
  /** The injected Clock, as the lease takes it. */
  clock: ConstructorParameters<typeof StoreLease>[1];
  config: FactoryConfig;
  /** This replica, as the lease's owner. */
  owner: string;
  /** Where prompts/ lives. */
  codeRoot: string;
  log: Logger;
}

export function coordinatorWiring(d: WiringDeps): (ports: CoordinatorPorts) => Coordinator {
  const lease = new StoreLease(syncLeaseOps(d.store, COORDINATOR_LEASE), d.clock, { lease_ms: d.config.run_timeout_ms + LEASE_MARGIN_MS, heartbeat_ms: d.config.heartbeat_ms }, d.owner);
  const agent = coordinatorAgent({ ...d, prompt: () => readFile(join(d.codeRoot, COORDINATOR_PROMPT), "utf8").catch(() => null) });
  const parts = { store: new CoordinatorStore(storeSql(d.store)), lease, agent, clock: d.clock, log: d.log };
  return (ports) => new Coordinator(parts, ports);
}
