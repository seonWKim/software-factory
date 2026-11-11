import type { AppShell } from "../../../src/interfaces/app-shell.js";
import type { Timers } from "../common/timers.js";
export declare const RELOAD_DELAY_MS: number;
export declare const STARTUP_ERROR_TITLE: string;
export interface WindowOptions {
  width: number;
  height: number;
  title: string;
  webPreferences: { contextIsolation: boolean; nodeIntegration: boolean; sandbox: boolean; preload: string };
}
export declare function windowOptions(preload: string): WindowOptions;
/** The Electron main-process modules the shell uses; tests pass a mock. */
export type ElectronLike = Record<"app" | "BrowserWindow" | "Menu" | "Tray" | "nativeImage" | "globalShortcut" | "Notification", unknown>;
export interface MenuEntry {
  label: string;
  click: () => void;
}
export declare function createMacosShell(
  electron: ElectronLike,
  options: { preload: string; keepRunningWhenClosed?: boolean; menu?: readonly MenuEntry[]; timers?: Timers },
): AppShell;
