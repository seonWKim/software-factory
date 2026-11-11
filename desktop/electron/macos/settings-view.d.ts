import type { QuickAddShortcut } from "./shortcut.js";
export declare const SETTINGS: { get: string; set: string };
export declare function settingsOptions(preload: string): Record<string, unknown>;
export declare function createSettingsView(
  electron: Record<"BrowserWindow" | "ipcMain", unknown>,
  o: { pageUrl: string; preload: string; shortcut: QuickAddShortcut },
): { open(): void };
