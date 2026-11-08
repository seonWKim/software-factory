// The PR write both the GitHub broker's `github.open_pr` (sessions, the PR body refresh) and the forge's `openPr`
// (outbound's `github-change`, RFC 0015 M7) make: one implementation until the broker's tool goes.

import type { OpenPrInput } from "../../interfaces/forge.js";
import type { GitHubApi } from "../../interfaces/github-credentials.js";
import { GitHubError, type RepoRef } from "./github-client.js";

/**
 * Opens the branch's PR, or gives the open one this push's title and body (issue #229: the description follows the
 * branch), then adds or removes each label (adding creates a missing label; removing an absent one is a no-op).
 * Throws the client's error on a failure.
 */
export async function openOrUpdatePr(client: GitHubApi, repo: RepoRef, a: OpenPrInput): Promise<{ number: number; url: string }> {
  const { owner, name } = repo;
  const open = await client.request<{ number: number; html_url: string }[]>(
    "GET",
    `/repos/${owner}/${name}/pulls?state=open&head=${encodeURIComponent(`${owner}:${a.branch}`)}`,
  );
  const pr = open[0]
    ? await client.request<{ number: number; html_url: string }>("PATCH", `/repos/${owner}/${name}/pulls/${open[0].number}`, { title: a.title, body: a.body })
    : await client.request<{ number: number; html_url: string }>("POST", `/repos/${owner}/${name}/pulls`, {
      head: a.branch,
      base: a.base_ref,
      title: a.title,
      body: a.body,
    });
  for (const [label, present] of Object.entries(a.labels ?? {})) {
    const path = `/repos/${owner}/${name}/issues/${pr.number}/labels`;
    if (present) {
      await client.request("POST", path, { labels: [label] });
      continue;
    }
    try {
      await client.request("DELETE", `${path}/${encodeURIComponent(label)}`);
    } catch (err) {
      if (!(err instanceof GitHubError && err.status === 404)) throw err;
    }
  }
  return { number: pr.number, url: pr.html_url };
}

/**
 * Whether git's push stderr says the forge refused the credentials (HTTP 401/403, a denied permission, failed
 * authentication), as opposed to a rejected push (non-fast-forward, a hook, a protected branch).
 */
export function forgeAuthRefused(stderr: string): boolean {
  return (
    /The requested URL returned error: (401|403)\b/.test(stderr) ||
    /Authentication failed for/.test(stderr) ||
    /Permission to \S+ denied/.test(stderr) ||
    /Invalid username or (password|token)/.test(stderr)
  );
}
