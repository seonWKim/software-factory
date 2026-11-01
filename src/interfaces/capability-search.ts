// design §7. Finding a capability is not permission to use it. Impls: list everything, BM25 over docs.

export interface Capability {
  /** For `doc` and `skill`: the repo-relative path an agent can Read for the full text. */
  id: string;
  /** `doc`: a markdown doc; `skill`: a file under `skills/`. */
  kind: "skill" | "doc" | "tool" | "mcp";
  name: string;
  summary: string;
}

export interface CapabilitySearch {
  search(query: string, limit: number): Promise<Capability[]>;
}
