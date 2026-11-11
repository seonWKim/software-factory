import type { AppShell } from "../../../src/interfaces/app-shell.js";
export type ShortcutChange = { ok: true; accelerator: string } | { ok: false; message: string };
export interface QuickAddShortcut {
  current(): string | null;
  change(next: unknown): ShortcutChange;
}
export declare function refusedMessage(accelerator: string, kept: string | null): string;
export declare function quickAddShortcut(o: {
  shell: Pick<AppShell, "registerShortcut" | "unregisterShortcut">;
  accelerator: string;
  onPress: () => void;
  notify: (message: string) => void;
  save: (accelerator: string) => void;
}): QuickAddShortcut;
