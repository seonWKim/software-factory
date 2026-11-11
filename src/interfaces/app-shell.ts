// The desktop shell around a running factory: one window on the dashboard, a menu bar item with the factory's
// state and its needs-you count, and a Quit that drains the factory before the shell exits. The shell is wired
// directly by its desktop entry, not chosen in factory.config.json (docs/plugins/app-shell.md). First
// implementation: macOS, in desktop/electron/macos/. Core never calls it.

/** What the menu bar shows: the factory's state as the dashboard API reports it, and the needs-you count (null: unknown). */
export interface ShellStatus {
  readonly state: string;
  readonly needsYou: number | null;
}

export interface AppShell {
  /** Shows the dashboard at `url` in the shell's one window: opens it the first time, shows and focuses it after. */
  openWindow(url: string): void;
  /** Shows `status` in the menu bar. */
  setStatus(status: ShellStatus): void;
  /** Sets what Quit waits for before the shell exits (the factory's drain). Without one, Quit exits at once. */
  onQuit(drain: () => Promise<void>): void;
  /** Quits: runs the drain once, then exits. Closing the window is not a Quit while the shell keeps running when closed. */
  quit(): void;
}
