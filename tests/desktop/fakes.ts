// Fakes for the desktop shell's tests: an AppShell, a child process and Electron's main-process modules (with
// globalShortcut and ipcMain).
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
  /** The registered shortcuts and what each runs. */
  readonly shortcuts = new Map<string, () => void>();
  private drain: () => Promise<void> = async () => {};
  private quitting = false;

  /** `taken`: accelerators another app holds, which registerShortcut refuses. */
  constructor(
    private readonly keepRunningWhenClosed = true,
    readonly taken: ReadonlySet<string> = new Set(),
  ) {}

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
  registerShortcut(accelerator: string, onPress: () => void): boolean {
    if (this.taken.has(accelerator) || this.shortcuts.has(accelerator)) return false;
    this.shortcuts.set(accelerator, onPress);
    return true;
  }
  unregisterShortcut(accelerator: string): void {
    this.shortcuts.delete(accelerator);
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
  visible: boolean;
  focused = false;
  destroyed = false;
  openHandler: (() => { action: string }) | null = null;
  /** The channels sent to the page, in order. */
  readonly sent: string[] = [];
  readonly webContents = Object.assign(new EventEmitter(), {
    setWindowOpenHandler: (h: () => { action: string }) => {
      this.openHandler = h;
    },
    send: (channel: string) => {
      this.sent.push(channel);
    },
  });
  constructor(readonly options: Record<string, unknown>) {
    super();
    // As Electron: a window shows on creation unless its options say `show: false`.
    this.visible = options.show !== false;
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
    this.focused = false;
  }
  focus(): void {
    this.focused = true;
  }
  isVisible(): boolean {
    return this.visible;
  }
  /** The window loses the keyboard (the person clicks elsewhere). */
  blur(): void {
    this.focused = false;
    this.emit("blur");
  }
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

/** Electron's globalShortcut: `taken` holds accelerators another app owns; a string with no key is not an accelerator. */
export class MockGlobalShortcut {
  readonly registered = new Map<string, () => void>();
  readonly taken = new Set<string>();
  register(accelerator: string, onPress: () => void): boolean {
    if (!/^(?:[A-Za-z]+\+)*[A-Za-z0-9]+$/.test(accelerator)) throw new Error(`Error processing argument: ${accelerator} is not an accelerator`);
    if (this.taken.has(accelerator) || this.registered.has(accelerator)) return false;
    this.registered.set(accelerator, onPress);
    return true;
  }
  isRegistered(accelerator: string): boolean {
    return this.registered.has(accelerator);
  }
  unregister(accelerator: string): void {
    this.registered.delete(accelerator);
  }
  unregisterAll(): void {
    this.registered.clear();
  }
  /** The person presses `accelerator`. */
  press(accelerator: string): void {
    this.registered.get(accelerator)?.();
  }
}

type Handler = (e: { sender: unknown }, ...args: unknown[]) => unknown;

/** Electron's ipcMain: `invoke` calls a handler as a page's ipcRenderer.invoke would, from `sender`. */
export class MockIpcMain {
  readonly handlers = new Map<string, Handler>();
  handle(channel: string, fn: Handler): void {
    if (this.handlers.has(channel)) throw new Error(`a second handler for ${channel}`);
    this.handlers.set(channel, fn);
  }
  invoke(channel: string, sender: unknown, ...args: unknown[]): Promise<unknown> {
    const fn = this.handlers.get(channel);
    if (!fn) return Promise.reject(new Error(`no handler for ${channel}`));
    return Promise.resolve(fn({ sender }, ...args));
  }
}

/** Electron's app, BrowserWindow, Menu, Tray, nativeImage, globalShortcut and ipcMain, as far as the macOS shell uses them. */
export function electronMock() {
  const windows: MockWindow[] = [];
  const tray = { title: "", tooltip: "", menu: [] as MenuItem[], made: 0 };
  const app = new MockApp();
  const state = app;
  const globalShortcut = new MockGlobalShortcut();
  const ipcMain = new MockIpcMain();
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
    globalShortcut,
  };
  const menuItem = (label: string): MenuItem => tray.menu.find((i) => i.label === label)!;
  return { electron: { ...electron, ipcMain }, app, windows, tray, state, menuItem, globalShortcut, ipcMain, exited: () => state.exitCode !== null };
}

/** Lets pending promise callbacks run. */
export const flush = (): Promise<void> => new Promise((r) => setImmediate(r));
