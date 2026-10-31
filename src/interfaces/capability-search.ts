// design §7. Finding a capability is not permission to use it. First impl: list everything.

export interface Capability {
  id: string;
  kind: "skill" | "tool" | "mcp";
  name: string;
  summary: string;
}

export interface CapabilitySearch {
  search(query: string, limit: number): Promise<Capability[]>;
}
