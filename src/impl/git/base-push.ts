// The base push's git (design 05-sources, Local items; docs/plugins/forge.md): the one `git push` both the GitHub
// forge and the local forge make for `Forge.pushBase`, from the factory repo to its own origin.

import type { BasePushInput } from "../../interfaces/forge.js";
import { factoryGit, factoryRemoteUrl } from "../broker/trusted-git.js";

/**
 * One `git push` from the factory repo to its `origin`, of `sha` to the base branch only (`baseBranch`, any other ref
 * refused), with `--force-with-lease` on `expected_sha`, so it lands only while the remote base is still the one the
 * factory read (and `sha` descends from it, so it is a fast-forward). `--no-verify`: no hook runs. The push goes
 * through the factory repo's own git configuration for origin, as its fetches do: no credential is passed, stored
 * or logged here, and no API call is made. Throws on any failure; the caller retries.
 */
export async function pushBaseToOrigin(baseBranch: string, input: BasePushInput): Promise<void> {
  if (input.base_ref !== baseBranch) throw new Error(`refusing to push ${JSON.stringify(input.base_ref)}: the base branch is ${baseBranch}`);
  for (const sha of [input.sha, input.expected_sha]) {
    if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new Error(`not a commit sha: ${JSON.stringify(sha)}`);
  }
  const ref = `refs/heads/${input.base_ref}`;
  const r = await factoryGit(input.repo, ["push", "--quiet", "--no-verify", `--force-with-lease=${ref}:${input.expected_sha}`, "origin", `${input.sha}:${ref}`]);
  if (r.exit_code !== 0) throw new Error(`git push failed: ${r.stderr.trim().slice(0, 500)}`);
}

/** Whether the factory repo names an `origin` to push to: one read of its git config, no remote call. */
export async function hasOrigin(repo: string): Promise<boolean> {
  return "url" in (await factoryRemoteUrl(repo));
}
