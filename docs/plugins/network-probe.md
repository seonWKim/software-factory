# NetworkProbe

What it does: tells the controller whether the network the factory needs is back, during a `network` claim pause (design §5 Restarts, [05-restarts.md](../design/05-restarts.md)). A git fetch or push, the GitHub preflight or a model request that fails on DNS or connect is `network_unavailable`: the worker puts the run back in the queue with its attempt unchanged and pauses every claim. Once the pause's probe is due, the controller replica whose conditional update takes the probe (`claimProbe` on the `claim_pauses` row) asks the NetworkProbe; only that replica probes. A pass ends the pause and claims resume; a failure leaves the next probe 30 s later, backing off to 5 min. It is the same probe schedule as the `model_stall` pause.

Interface (`src/interfaces/network-probe.ts`): `probe(signal?)` returns `{ ok: true }` or `{ ok: false, host }`, the host name of the endpoint that did not answer and nothing else. It never throws.

Plugins:

- `http`: `HttpNetworkProbe`. One `HEAD` request to each endpoint the selected plugins already use, with no credential, no header and no body; any HTTP answer, whatever its status (a 401 too), passes. A DNS, connect or 10 s timeout error fails with that endpoint's host. The endpoints come from the existing config, with no setting of their own:
  - `https://api.github.com` when a GitHub plugin is selected (`plugins.broker`, `plugins.forge` or `auth` set to `github`, or `github-issues` among the sources). With no GitHub plugin, GitHub is never probed (local first).
  - `https://api.anthropic.com` when `claude-code` or `claude-cli` is in the runner or LLM chain.
  - `openai_compatible.base_url` when `openai-compatible` is in the runner or LLM chain.
  - With no remote plugin selected there is nothing to ask, so a probe passes at once.
  - Enable: `"plugins": { "network_probe": "http", ... }`, or leave `network_probe` out: it is the default. Secrets: none. Settings: none.

Solo developer and enterprise team: the same `http` plugin and no extra setting. An enterprise setup that points its plugins at a shared forge or model endpoint gets those endpoints probed, since the targets follow the selection and its config.

Turn on / off: it cannot be turned off, and there is no other plugin yet; with no probe at all (a test controller built without one) a network pause ends at its first probe time, as a stall pause does without an LLM provider.

## History

No earlier decision is recorded for this topic.
