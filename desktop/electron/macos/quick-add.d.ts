import type { QuickAddResult } from "../../../src/core/quick-add.js";
import type { PostTask } from "./tasks-client.js";
export declare const BOX: { preview: string; key: string; opened: string };
export declare function boxOptions(preload: string): Record<string, unknown>;
export declare function createQuickAdd(
  electron: Record<"BrowserWindow" | "ipcMain", unknown>,
  o: { pageUrl: string; preload: string; post: PostTask; parse: ((words: string) => QuickAddResult) | null; newId: () => string },
): { prepare(): void; open(): void };
