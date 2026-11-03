# KeepAwake

What it does: keeps the host from idle-sleeping while a job runs. The worker holds it right after it claims a run and releases it when the run is done, whether the run succeeded or failed. It is never held while the worker is idle, so the machine can sleep between jobs. Staying awake is best effort: if the hold fails, the worker logs a warning and runs the job anyway.

Plugins:

- `caffeinate`: `CaffeinateKeepAwake`. While held, runs `caffeinate -i -s -w <worker pid>` (macOS): `-i` prevents idle sleep, `-s` prevents system sleep on AC power, `-w` ends caffeinate when the worker process exits, so a crash cannot leave the machine awake. Release kills it.
  - Enable: `"plugins": { "awake": "caffeinate", ... }`, or leave `awake` out on macOS. Secrets: none. Settings: the `caffeinate` executable on `PATH` (it ships with macOS at `/usr/bin/caffeinate`).
  - Startup failure: if `caffeinate` is selected (explicitly or by the macOS default) and there is no `caffeinate` executable on `PATH`, `build()` fails at startup with an error naming `plugins.awake`, `caffeinate` and the `none` alternative.
- `none`: `NoKeepAwake`. Does nothing; the host's own power settings decide.
  - Enable: `"plugins": { "awake": "none", ... }`, or leave `awake` out on any OS other than macOS. Secrets: none.

Platform default: with no `plugins.awake` key, the factory picks `caffeinate` when `process.platform` is `darwin` and `none` everywhere else. The checked-in `factory.config.json` has no `awake` key, so the platform decides.

Turn on / off: set `plugins.awake` to `caffeinate` (on) or `none` (off); delete the key to go back to the platform default.

**Closing the laptop lid still sleeps a Mac.** `caffeinate` only stops idle and system sleep; macOS sleeps on lid close regardless (unless an external display, power and keyboard are attached). Keep the lid open while jobs run. A worker that sleeps anyway recovers through the lease rules in design §5 (host sleep, [05-coordination.md](../design/05-coordination.md)).

Linux and Windows plugins do not exist yet.

## History

No earlier decision is recorded for this topic.
