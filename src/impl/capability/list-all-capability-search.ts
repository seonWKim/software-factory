import type { Capability, CapabilitySearch } from "../../interfaces/capability-search.js";

/** Phase 1: no ranking, returns everything registered. */
export class ListAllCapabilitySearch implements CapabilitySearch {
  constructor(private readonly capabilities: readonly Capability[]) {}

  async search(_query: string, limit: number): Promise<Capability[]> {
    return this.capabilities.slice(0, limit);
  }
}
