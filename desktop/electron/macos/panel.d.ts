export interface PanelPreferences {
  contextIsolation: boolean;
  nodeIntegration: boolean;
  sandbox: boolean;
  preload: string;
}
export declare function panelPreferences(preload: string): PanelPreferences;
export declare function panelWindow(BrowserWindow: unknown, options: Record<string, unknown>, pageUrl: string): unknown;
export declare function showFocused(w: { show(): void; focus(): void }): void;
