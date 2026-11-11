// The quick-add box's system-wide shortcut over AppShell's registerShortcut and unregisterShortcut: registered by
// main.js once the shell runs, from `app.quick_add_shortcut`, and changed from the shell's settings view. A refused shortcut (another app
// holds it, or it is not valid) never stops the shell: the person gets a message and the previous one stays.

/** The message for a refused shortcut, naming the one that stays (or how to pick one when none is held). */
export function refusedMessage(accelerator, kept) {
  const why = `The shortcut ${accelerator} could not be registered: another app uses it, or it is not a valid shortcut.`;
  return kept === null ? `${why} Pick another under "Quick-add shortcut…" in the menu bar menu.` : `${why} ${kept} stays the quick-add shortcut.`;
}

/**
 * Registers `accelerator` on `shell` for `onPress`. `notify(message)` tells the person when the start's shortcut is refused; `save(accelerator)`
 * writes a changed shortcut to the config. Returns the current shortcut (null when none is held) and `change`.
 */
export function quickAddShortcut({ shell, accelerator, onPress, notify, save }) {
  let current = null;
  if (shell.registerShortcut(accelerator, onPress)) current = accelerator;
  else notify(refusedMessage(accelerator, null));
  return {
    current: () => current,
    /** Registers `next` before releasing the old one, so a refusal keeps the old one held. */
    change(next) {
      const accelerator = typeof next === "string" ? next.trim() : "";
      if (accelerator === "") return { ok: false, message: "Press a shortcut first, such as Alt+Space." };
      if (accelerator === current) return { ok: true, accelerator };
      // The settings view shows the refusal itself.
      if (!shell.registerShortcut(accelerator, onPress)) return { ok: false, message: refusedMessage(accelerator, current) };
      if (current !== null) shell.unregisterShortcut(current);
      current = accelerator;
      save(accelerator);
      return { ok: true, accelerator };
    },
  };
}
