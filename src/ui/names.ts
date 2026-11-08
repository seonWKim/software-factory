// Display names on the status page (RFC 0015 §8, M9): the store keeps user ids only; a name is read by id from
// Identity's identity_profiles when a page shows the id, and never stored anywhere else.

/** Names by user id; absent: the page shows ids only. */
export type DisplayNames = (user_ids: readonly string[]) => Promise<ReadonlyMap<string, string>>;

/** The name of `id`, or null when it has none (or no lookup is wired). */
export async function displayName(names: DisplayNames | undefined, id: string): Promise<string | null> {
  if (!names) return null;
  return (await names([id])).get(id) ?? null;
}

/** `Name (id)` when the user has a name, else the id: what a page shows where it showed the id. */
export async function userLabel(names: DisplayNames | undefined, id: string): Promise<string> {
  const name = await displayName(names, id);
  return name === null ? id : `${name} (${id})`;
}
