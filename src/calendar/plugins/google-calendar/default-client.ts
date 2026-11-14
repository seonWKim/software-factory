// The factory's own Google OAuth client (docs/plugins/calendar-source.md, Turn on): a Desktop-app client the connect
// uses when the secret file holds no GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, so the owner sets up nothing in Google
// Cloud. Its ID is a public identifier and lives here. Google treats a Desktop-app client's secret as not confidential,
// but this repository holds no credential: the release build writes the secret into DEFAULT_SECRET_MODULE beside this
// file (untracked, listed in this folder's .gitignore) before it compiles, and the connect reads it from there. A build
// without that module, or with no ID here, has no default client: the connect then asks for the owner's own client.

/** The factory's Desktop-app OAuth client ID; empty until the factory's Google client exists. */
export const DEFAULT_GOOGLE_CLIENT_ID = "";

/** The module the release build writes, exporting `DEFAULT_GOOGLE_CLIENT_SECRET`; never tracked. */
export const DEFAULT_SECRET_MODULE = "./default-client-secret.js";

/** An OAuth client: its ID and its secret. */
export interface GoogleClient {
  id: string;
  secret: string;
}

/** The default client, or null when this build carries none. `load` imports DEFAULT_SECRET_MODULE; tests fake it. */
export async function defaultGoogleClient(
  o: { id: string; load: () => Promise<unknown> } = { id: DEFAULT_GOOGLE_CLIENT_ID, load: () => import(/* @vite-ignore */ DEFAULT_SECRET_MODULE) },
): Promise<GoogleClient | null> {
  if (o.id === "") return null;
  const secret = await o.load().then(
    (m) => (m as { DEFAULT_GOOGLE_CLIENT_SECRET?: unknown }).DEFAULT_GOOGLE_CLIENT_SECRET,
    () => undefined,
  );
  return typeof secret === "string" && secret !== "" && !/\s/.test(secret) ? { id: o.id, secret } : null;
}
