// Types of app-data.js for the tests and typecheck; the shell itself runs the plain module.
export declare const DEFAULT_UI_PORT: number;
export interface AppDataPaths {
  readonly dir: string;
  readonly config: string;
  readonly state: string;
  readonly log: string;
  readonly chromium: string;
}
export interface ShellConfig {
  readonly checkout: string;
  readonly ui_port: number;
  readonly keep_running_when_closed: boolean;
}
/** The fs calls the shell makes; node:fs fits. */
export interface ShellFs {
  readFileSync(path: string, encoding: "utf8"): string;
  writeFileSync(path: string, text: string): void;
  appendFileSync(path: string, text: string): void;
  mkdirSync(path: string, options: { recursive: true }): unknown;
  openSync(path: string, flags: "a"): number;
  closeSync(fd: number): void;
}
export declare function appDataPaths(home: string): AppDataPaths;
export declare function loadShellConfig(paths: AppDataPaths, fs: ShellFs, defaultCheckout: string): ShellConfig;
