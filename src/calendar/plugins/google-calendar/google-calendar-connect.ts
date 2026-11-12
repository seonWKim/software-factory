// `factory setup calendar google` (docs/plugins/calendar-source.md, Turn on): the OAuth consent that gives the
// google-calendar plugin its refresh token. The client ID and secret are read from the secret file, or asked once
// with hidden input; the browser opens Google's consent page for calendar.readonly only, with a PKCE S256 challenge,
// a random state and a redirect to a loopback listener on 127.0.0.1 that closes after 5 minutes. The code is
// exchanged, the answer must grant exactly calendar.readonly and carry a refresh token, and only then are the three
// secrets stored, together. Every value stays in memory until then; no message carries one. The HTTP client is
// injected and the timeout runs on the context's Clock, so no test calls Google or waits.

import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Clock } from "../../../interfaces/clock.js";
import type { ConnectContext, ConnectHook } from "../../../plugin-api.js";
import type { SecretName } from "../../../interfaces/secret-store.js";
import { CALENDAR_READONLY_SCOPE, type HttpClient, TOKEN_URL, fail, json } from "./google-calendar-source.js";

export const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
/** How long the loopback listener waits for the browser's callback. */
export const CONNECT_TIMEOUT_MS = 5 * 60_000;
const CALLBACK_PATH = "/callback";
const BACK_TO_TERMINAL = "Go back to the terminal: it says whether the connection worked. You can close this tab.";

export interface GoogleConnectOptions {
  http: HttpClient;
  /** The secret names the descriptor declares. */
  names: { refreshToken: SecretName; clientId: SecretName; clientSecret: SecretName };
}

/** The descriptor's connect hook: `factory setup calendar google`, and `--disconnect`. */
export function googleCalendarConnect(o: GoogleConnectOptions): ConnectHook {
  const all = [o.names.clientId, o.names.clientSecret, o.names.refreshToken];
  return {
    command: "google",
    connect: (ctx) => connect(o, ctx),
    async disconnect(ctx) {
      await ctx.removeSecrets(all);
      ctx.print(`   removed ${all.join(", ")} from ${ctx.secretsFile}`);
    },
  };
}

async function connect(o: GoogleConnectOptions, ctx: ConnectContext): Promise<void> {
  const { clientId: idName, clientSecret: secretName, refreshToken } = o.names;
  const stored = async (name: SecretName) => (await ctx.secrets.get(name))?.reveal() || null;
  let clientId = await stored(idName);
  let clientSecret = await stored(secretName);
  if (clientId && clientSecret) ctx.print(`   using the ${idName} and ${secretName} in ${ctx.secretsFile}`);
  else {
    ctx.print("   An OAuth client of type Desktop app, with the Google Calendar API enabled (Google Cloud console,");
    ctx.print("   APIs & Services → Credentials). Its ID and secret are held in memory until the sign-in passes.");
    clientId ??= await askHidden(ctx, idName);
    clientSecret ??= await askHidden(ctx, secretName);
  }

  const verifier = base64url(randomBytes(32));
  const state = base64url(randomBytes(24));
  const loopback = await listen(ctx.clock);
  let callback: URLSearchParams;
  try {
    const url = consentUrl({ clientId, redirectUri: loopback.redirectUri, challenge: challengeOf(verifier), state });
    ctx.print(`   Sign in and allow read-only calendar access in the browser. If it does not open, go to:\n   ${url}`);
    await ctx.openBrowser(url);
    callback = await loopback.callback;
  } finally {
    loopback.close();
  }
  const error = callback.get("error");
  if (error !== null) throw fail(`the consent answered an error (${/^[a-z_]{1,64}$/.test(error) ? error : "unknown"}): nothing stored`);
  if (callback.get("state") !== state) throw fail("the callback's state did not match this sign-in: refused, nothing stored");
  const code = callback.get("code");
  if (!code) throw fail("the callback carried no authorization code: nothing stored");

  const answer = await exchange(o.http, { code, clientId, clientSecret, redirectUri: loopback.redirectUri, verifier });
  if (!onlyReadonly(answer.scope)) throw fail("the token answer granted a scope other than exactly calendar.readonly: refused, nothing stored");
  if (typeof answer.refresh_token !== "string" || answer.refresh_token === "") throw fail("the token answer carried no refresh token: nothing stored");
  await ctx.storeSecrets(new Map([[idName, clientId], [secretName, clientSecret], [refreshToken, answer.refresh_token]]));
  ctx.print(`   stored ${idName}, ${secretName} and ${refreshToken} in ${ctx.secretsFile}`);
}

async function askHidden(ctx: ConnectContext, name: SecretName): Promise<string> {
  const value = (await ctx.ask.hidden(`   Paste ${name} (hidden): `)).trim();
  if (!value || /\s/.test(value)) throw fail(`${name} is empty or holds whitespace: nothing stored`);
  return value;
}

const base64url = (b: Buffer): string => b.toString("base64url");

/** The PKCE S256 challenge of `verifier` (RFC 7636). */
export function challengeOf(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

/** The consent page: calendar.readonly only, offline access (a refresh token), PKCE S256 and the state. */
export function consentUrl(p: { clientId: string; redirectUri: string; challenge: string; state: string }): string {
  const q = new URLSearchParams({
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    response_type: "code",
    scope: CALENDAR_READONLY_SCOPE,
    access_type: "offline",
    prompt: "consent",
    code_challenge: p.challenge,
    code_challenge_method: "S256",
    state: p.state,
  });
  return `${AUTH_URL}?${q}`;
}

/** True when `scope`, a space-separated set, is exactly calendar.readonly. */
export function onlyReadonly(scope: unknown): boolean {
  if (typeof scope !== "string") return false;
  const granted = new Set(scope.split(" ").filter((s) => s !== ""));
  return granted.size === 1 && granted.has(CALENDAR_READONLY_SCOPE);
}

async function exchange(
  http: HttpClient,
  p: { code: string; clientId: string; clientSecret: string; redirectUri: string; verifier: string },
): Promise<{ scope?: unknown; refresh_token?: unknown }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: p.code,
    client_id: p.clientId,
    client_secret: p.clientSecret,
    redirect_uri: p.redirectUri,
    code_verifier: p.verifier,
  }).toString();
  let res;
  try {
    res = await http(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  } catch {
    throw fail("token exchange failed (no answer): nothing stored");
  }
  if (res.status !== 200) throw fail(`token exchange failed (HTTP ${res.status}): nothing stored`);
  return json(res, "token exchange");
}

interface Loopback {
  redirectUri: string;
  /** The first callback's query; rejects when CONNECT_TIMEOUT_MS passes first. */
  callback: Promise<URLSearchParams>;
  close(): void;
}

/** A listener on 127.0.0.1, on a port the system picks, for one callback within CONNECT_TIMEOUT_MS of `clock`. */
function listen(clock: Clock): Promise<Loopback> {
  let answer!: (q: URLSearchParams) => void;
  let refuse!: (e: Error) => void;
  const callback = new Promise<URLSearchParams>((res, rej) => ((answer = res), (refuse = rej)));
  // Handled where it is awaited; this keeps a timeout before that from counting as unhandled.
  callback.catch(() => undefined);
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== CALLBACK_PATH) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(BACK_TO_TERMINAL);
    answer(url.searchParams);
  });
  const timer = new AbortController();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      clock.sleep(CONNECT_TIMEOUT_MS, timer.signal).then(
        () => refuse(fail("no answer from the browser within 5 minutes: the listener closed, nothing stored")),
        () => undefined,
      );
      resolve({
        redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
        callback,
        close() {
          timer.abort();
          server.close();
          server.closeAllConnections();
        },
      });
    });
  });
}
