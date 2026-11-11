// Fakes for the desktop shell's tests: an AppShell, a child process and Electron's main-process modules.
// Nothing here starts Electron or a real process.
import { EventEmitter } from "node:events";
import type { AppShell, ShellStatus } from "../../src/interfaces/app-shell.js";
import { menuTitle } from "../../desktop/electron/common/status.js";
import type { ElectronLike } from "../../desktop/electron/macos/app-shell.js";

/** The AppShell fake: records what the shell would show. */
export class FakeAppShell implements AppShell {
  readonly windows: string[] = [];
  visible = false;
  status: ShellStatus = { state: "starting", needsYou: null };
  exited = false;
  private drain: () => Promise<void> = async () => {};
  private quitting = false;

  constructor(private readonly keepRunningWhenClosed = true) {}

  openWindow(url: string): void {
    if (this.windows.length === 0) this.windows.push(url);
    this.visible = true;
  }
  setStatus(status: ShellStatus): void {
    this.status = status;
  }
  onQuit(drain: () => Promise<void>): void {
    this.drain = drain;
  }
  quit(): void {
    if (this.quitting) return;
    this.quitting = true;
    void this.drain().finally(() => (this.exited = true));
  }
  menuText(): string {
    return menuTitle(this.status);
  }
  closeWindow(): void {
    this.visible = false;
    if (!this.keepRunningWhenClosed) this.quit();
  }
}

/** A child process that exits when the test says so; `signals` records every kill. */
export class FakeChild extends EventEmitter {
  readonly signals: string[] = [];
  kill(signal: string): boolean {
    this.signals.push(signal);
    return true;
  }
  exit(code: number | null, signal: string | null = null): void {
    this.emit("exit", code, signal);
  }
}

/** A spawn that hands out FakeChild processes and records each call. */
export function fakeSpawn() {
  const calls: { command: string; args: readonly string[]; options: Record<string, unknown>; child: FakeChild }[] = [];
  const spawn = (command: string, args: readonly string[], options: Record<string, unknown>) => {
    const child = new FakeChild();
    calls.push({ command, args, options, child });
    return child;
  };
  return { spawn, calls };
}

/** An event with Electron's preventDefault. */
class Ev {
  prevented = false;
  preventDefault(): void {
    this.prevented = true;
  }
}

export class MockWindow extends EventEmitter {
  readonly loads: string[] = [];
  visible = true;
  destroyed = false;
  openHandler: (() => { action: string }) | null = null;
  readonly webContents = Object.assign(new EventEmitter(), {
    setWindowOpenHandler: (h: () => { action: string }) => {
      this.openHandler = h;
    },
  });
  constructor(readonly options: Record<string, unknown>) {
    super();
  }
  loadURL(url: string): Promise<void> {
    this.loads.push(url);
    return Promise.resolve();
  }
  show(): void {
    this.visible = true;
  }
  hide(): void {
    this.visible = false;
  }
  focus(): void {}
  isDestroyed(): boolean {
    return this.destroyed;
  }
  /** The person closes the window (the red button, Cmd+W). */
  close(): void {
    const e = new Ev();
    this.emit("close", e);
    if (!e.prevented) {
      this.destroyed = true;
      this.visible = false;
    }
  }
  /** A navigation the page starts; true when the shell allowed it. */
  navigate(url: string): boolean {
    const e = new Ev();
    this.webContents.emit("will-navigate", e, url);
    return !e.prevented;
  }
}

/** Electron's app: emits before-quit on quit() and records the exit code. */
export class MockApp extends EventEmitter {
  exitCode: number | null = null;
  /** Cmd+Q, the app menu's Quit, or app.quit(): Electron emits before-quit, then exits unless it was prevented. */
  quit(): void {
    const e = new Ev();
    this.emit("before-quit", e);
    if (!e.prevented) this.exitCode = 0;
  }
  exit(code: number): void {
    this.exitCode = code;
  }
}

type MenuItem = { label?: string; click?: () => void; accelerator?: string };

/** Electron's app, BrowserWindow, Menu, Tray and nativeImage, as far as the macOS shell uses them. */
export function electronMock() {
  const windows: MockWindow[] = [];
  const tray = { title: "", tooltip: "", menu: [] as MenuItem[], made: 0 };
  const app = new MockApp();
  const state = app;
  class BrowserWindow extends MockWindow {
    constructor(options: Record<string, unknown>) {
      super(options);
      windows.push(this);
    }
  }
  class Tray {
    constructor() {
      tray.made += 1;
    }
    setTitle(t: string): void {
      tray.title = t;
    }
    setToolTip(t: string): void {
      tray.tooltip = t;
    }
    setContextMenu(m: MenuItem[]): void {
      tray.menu = m;
    }
  }
  const electron: ElectronLike = {
    app,
    BrowserWindow,
    Tray,
    Menu: { buildFromTemplate: (t: MenuItem[]) => t },
    nativeImage: { createEmpty: () => ({}) },
  };
  const menuItem = (label: string): MenuItem => tray.menu.find((i) => i.label === label)!;
  return { electron, app, windows, tray, state, menuItem, exited: () => state.exitCode !== null };
}

/** Lets pending promise callbacks run. */
export const flush = (): Promise<void> => new Promise((r) => setImmediate(r));
