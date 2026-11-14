// The factory's own Google OAuth client (docs/plugins/calendar-source.md, Turn on): a Desktop-app client, so Connect
// works with no client of the owner's. Its ID is the constant below; its secret is never in src/ or git: a release
// build writes it from a build-time value into the staged dist/, beside this file's compiled copy, as
// default-client-secret.js (scripts/build.mjs, docs/setup.md). Connect and the token refresh use it only when the
// secret file holds neither GOOGLE_CLIENT_ID nor GOOGLE_CLIENT_SECRET. A missing or unreadable module is no default.

/** The factory's Desktop-app OAuth client ID; empty until the owner sets it, and empty means no default client. */
export const DEFAULT_GOOGLE_CLIENT_ID = "";
/** The generated module, relative to this file; it exports DEFAULT_GOOGLE_CLIENT_SECRET. */
export const DEFAULT_CLIENT_SECRET_MODULE = "./default-client-secret.js";

/** The default client. The secret is behind `reveal`, so printing or serializing the object never shows it. */
export interface DefaultClient {
  clientId: string;
  clientSecret: { reveal(): string };
}

/** Where the default client comes from: loadDefaultClient in the plugin, a fake in tests. */
export type DefaultClientLoader = () => Promise<DefaultClient | null>;

/**
 * The default client, or null when there is none: no client ID, no generated module (every build without a release
 * value, and src/), or a module that fails to load or exports no usable value. Never throws.
 */
export async function loadDefaultClient(o: { clientId?: string; moduleUrl?: string } = {}): Promise<DefaultClient | null> {
  const clientId = o.clientId ?? DEFAULT_GOOGLE_CLIENT_ID;
  if (clientId === "") return null;
  let secret: unknown;
  try {
    // A computed specifier: the typecheck passes without the module, which only a release build writes.
    const url = o.moduleUrl ?? new URL(DEFAULT_CLIENT_SECRET_MODULE, import.meta.url).href;
    secret = ((await import(url)) as { DEFAULT_GOOGLE_CLIENT_SECRET?: unknown }).DEFAULT_GOOGLE_CLIENT_SECRET;
  } catch {
    return null;
  }
  if (typeof secret !== "string" || secret === "" || /\s/.test(secret)) return null;
  const value = secret;
  return { clientId, clientSecret: { reveal: () => value } };
}

/** The default client when both stored client values are empty; null when either is set or there is no default. */
export async function defaultUnlessStored(stored: { id: string | null; secret: string | null }, load?: DefaultClientLoader): Promise<DefaultClient | null> {
  if (stored.id || stored.secret || !load) return null;
  return load();
}
