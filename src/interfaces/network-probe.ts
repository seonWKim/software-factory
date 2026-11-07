// Whether the network the factory needs is back (design §5 Restarts, network pause). The controller asks it once
// a `network` claim pause's probe is due; a pass resumes claims, a failure moves the next probe later.

/** A probe's answer. `host`: the one endpoint that did not answer, its host name only. */
export type NetworkProbeResult = { ok: true } | { ok: false; host: string };

export interface NetworkProbe {
  /**
   * Asks each endpoint of the selected plugins once (the forge, the model), with no credential and no body; ok
   * when every one answered with any HTTP status. Nothing to ask (no remote plugin selected): ok. Never throws.
   */
  probe(signal?: AbortSignal): Promise<NetworkProbeResult>;
}
