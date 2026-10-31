// Keeps the host from idle-sleeping while a job runs. The worker holds it around each claimed run and
// releases it when the run is done; it is never held while idle. Prod on macOS: `caffeinate`. Elsewhere: `none`.

export interface KeepAwake {
  /**
   * Asks the OS to stay awake until release(). Holding twice is the same as holding once. Never throws:
   * if the host cannot be kept awake, the implementation logs a warning and the job runs anyway.
   */
  hold(): Promise<void>;
  /** Drops the hold. A release without a hold does nothing. Never throws. */
  release(): Promise<void>;
}
