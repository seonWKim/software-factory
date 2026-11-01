import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Clock } from "../../interfaces/clock.js";
import type { GitHubCredentials } from "../../interfaces/github-credentials.js";
import { type Secret, type SecretStore, secretName } from "../../interfaces/secret-store.js";
import { OpaqueSecret } from "../secrets/env-file-secret-store.js";
import { GitHubError, type RepoRef } from "./github-client.js";

export const GITHUB_APP_ID = secretName("GITHUB_APP_ID");
/** The name the minted token carries; it is never read from or written to the secret file. */
const INSTALLATION_TOKEN = secretName("GITHUB_APP_INSTALLATION_TOKEN");
/** GitHub's installation tokens last an hour; mint a new one this long before the current one expires. */
const REFRESH_MS = 5 * 60_000;
/** GitHub rejects a JWT that lives over 10 minutes; iat is backdated a minute for clock drift. */
const JWT_BACKDATE_S = 60;
const JWT_LIFETIME_S = 540;

interface Minted {
  token: string;
  expires: number;
  permissions: Record<string, string>;
}

export interface AppCredentialsDeps {
  secrets: SecretStore;
  /** `github-app.pem`, next to the secret file. Read only when a token is minted. */
  keyFile: string;
  repo: RepoRef;
  clock: Clock;
  baseUrl?: string;
  fetch?: typeof fetch;
}

/**
 * The GitHub App's installation token for this repository, so every write shows as the App's bot. A JWT
 * signed with the App's key (RS256) is exchanged for a token limited to this one repository. The token is
 * cached until shortly before it expires; concurrent callers share one mint.
 */
export class AppCredentials implements GitHubCredentials {
  private cached: Minted | null = null;
  private minting: Promise<Minted> | null = null;

  constructor(private readonly d: AppCredentialsDeps) {}

  async token(): Promise<Secret | null> {
    if (!(await this.d.secrets.get(GITHUB_APP_ID))) return null;
    if (!this.cached || this.cached.expires - REFRESH_MS <= this.d.clock.now().getTime()) {
      this.minting ??= this.mint().finally(() => {
        this.minting = null;
      });
      this.cached = await this.minting;
    }
    return new OpaqueSecret(INSTALLATION_TOKEN, this.cached.token);
  }

  grant(): { expires_at: Date; permissions: Readonly<Record<string, string>> } | null {
    return this.cached ? { expires_at: new Date(this.cached.expires), permissions: this.cached.permissions } : null;
  }

  private async mint(): Promise<Minted> {
    const appId = await this.d.secrets.get(GITHUB_APP_ID);
    if (!appId) throw new Error("GITHUB_APP_ID missing from the secret file (SET_UP.md)");
    const key = await readFile(this.d.keyFile, "utf8").catch(() => {
      throw new Error(`GitHub App key not readable at ${this.d.keyFile} (SET_UP.md)`);
    });
    const jwt = this.jwt(appId.reveal(), key);
    const { owner, name } = this.d.repo;
    const inst = await this.call<{ id: number }>("GET", `/repos/${owner}/${name}/installation`, jwt);
    const t = await this.call<{ token: string; expires_at: string; permissions?: Record<string, string> }>(
      "POST", `/app/installations/${inst.id}/access_tokens`, jwt, { repositories: [name] },
    );
    return { token: t.token, expires: Date.parse(t.expires_at), permissions: t.permissions ?? {} };
  }

  private jwt(appId: string, key: string): string {
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const iat = Math.floor(this.d.clock.now().getTime() / 1000) - JWT_BACKDATE_S;
    const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat, exp: iat + JWT_LIFETIME_S, iss: appId })}`;
    return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(key, "base64url")}`;
  }

  private async call<T>(method: string, path: string, jwt: string, body?: unknown): Promise<T> {
    const res = await (this.d.fetch ?? fetch)(`${this.d.baseUrl ?? "https://api.github.com"}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwt}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "software-factory",
        ...(body !== undefined && { "Content-Type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new GitHubError(res.status, `GitHub App ${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }
}
