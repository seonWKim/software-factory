// Display names on the dashboard (RFC 0015 §8, M9): the store keeps user ids only; a name is read by id from
// Identity's identity_profiles when a page shows the id, and never stored anywhere else.

/** Names by user id; absent: the page shows ids only. */
export type DisplayNames = (user_ids: readonly string[]) => Promise<ReadonlyMap<string, string>>;

/** The name of `id`, or null when it has none (or no lookup is wired). */
export async function displayName(names: DisplayNames | undefined, id: string): Promise<string | null> {
  if (!names) return null;
  return (await names([id])).get(id) ?? null;
}

