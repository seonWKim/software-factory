import type { AppShell } from "../../../src/interfaces/app-shell.js";
import type { Timers } from "../common/timers.js";
export declare const RELOAD_DELAY_MS: number;
export interface WindowOptions {
  width: number;
  height: number;
  title: string;
  webPreferences: { contextIsolation: boolean; nodeIntegration: boolean; sandbox: boolean; preload: string };
}
export declare function windowOptions(preload: string): WindowOptions;
/** The Electron main-process modules the shell uses; tests pass a mock. */
export type ElectronLike = Record<"app" | "BrowserWindow" | "Menu" | "Tray" | "nativeImage", unknown>;
export declare function createMacosShell(electron: ElectronLike, options: { preload: string; keepRunningWhenClosed?: boolean; timers?: Timers }): AppShell;
