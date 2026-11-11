// The timer functions the shell's modules take (globalThis by default), so tests can pass fake ones.
export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(timer: unknown): void;
}
