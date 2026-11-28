import { Refusal, capped, defineTool, str } from "./guard.js";
import type { ToolContext } from "./types.js";

/** How long one Browse fetch may take before it is cut off. */
const BROWSE_TIMEOUT_MS = 30_000;

/** The owner-set URL as a URL, or the refusal: http or https only, with no credentials in it. */
function ownerUrl(raw: string | null): URL {
  if (raw === null) throw new Refusal("Browse: the owner set no URL for this run");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Refusal("Browse: the owner-set URL is not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Refusal(`Browse: the owner-set URL must be http or https, not ${url.protocol}`);
  if (url.username !== "" || url.password !== "") throw new Refusal("Browse: the owner-set URL may not carry credentials");
  return url;
}

/**
 * One GET of `url` with no body, no credentials and no redirect followed; its text, or a Refusal. Browse's fetch, and the
 * schedule browser grant's broker tool's (src/core/schedule-grants.ts).
 */
export async function fetchOwnerUrl(url: URL, opts: { fetch?: ToolContext["fetch"]; signal?: AbortSignal }): Promise<string> {
  const timeout = AbortSignal.timeout(BROWSE_TIMEOUT_MS);
  const res = await (opts.fetch ?? fetch)(url.href, {
    method: "GET",
    redirect: "manual",
    credentials: "omit",
    signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
  });
  if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
    throw new Refusal(`Browse: the owner-set URL answered with a redirect (${res.status}); redirects are not followed`);
  }
  if (!res.ok) throw new Refusal(`Browse: the owner-set URL answered ${res.status}`);
  return res.text();
}

/**
 * The routine role's web read (design 04-agents): one GET of the URL the owner set for the run (`browse_url` in the
 * guard policy), never any other. No body, no credentials, no redirect followed, so the run can neither send data
 * out nor be led to another host. It starts no sandbox: the fetch runs in the tool, its text capped like any other.
 */
export const Browse = defineTool({
  name: "Browse",
  description: "Fetch the one web page the owner set for this run (GET only) and return its text. Any other URL is refused.",
  input_schema: {
    type: "object",
    properties: { url: { type: "string", description: "The owner-set URL; may be left out" } },
    required: [],
    additionalProperties: false,
  },
  capability: "read",
  async run(input, ctx) {
    const asked = str(input, "url", false);
    const url = ownerUrl(ctx.policy.browse_url);
    if (asked !== undefined && asked !== ctx.policy.browse_url && asked !== url.href) {
      throw new Refusal("Browse fetches only the owner-set URL");
    }
    return capped(ctx, await fetchOwnerUrl(url, ctx));
  },
});
