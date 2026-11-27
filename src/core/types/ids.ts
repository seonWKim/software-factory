// Branded IDs and timestamps shared by every layer (split from src/core/types.ts). No vendor types here.
// Field names follow docs/design.md §2. IDs only, never display names.

export type Brand<T, B extends string> = T & { readonly __brand: B };

export type WorkItemId = Brand<string, "WorkItemId">;
export type RunId = Brand<string, "RunId">;
export type StateChangeId = Brand<string, "StateChangeId">;
export type HandoffId = Brand<string, "HandoffId">;
export type UserId = Brand<string, "UserId">;
export type AgentId = Brand<string, "AgentId">; // one per role identity, e.g. "agent:triage"
export type WorkerId = Brand<string, "WorkerId">;

/** ISO-8601 UTC timestamp. */
export type Timestamp = Brand<string, "Timestamp">;
