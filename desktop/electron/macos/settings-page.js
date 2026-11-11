// The shortcut settings page: records a key combination as an Electron accelerator and asks the main process
// (settings-view.js) to use it; a refused one is shown here and the previous one stays.
"use strict";
(() => {
  const field = document.getElementById("shortcut");
  const note = document.getElementById("note");
  const say = (text, error = false) => {
    note.textContent = text;
    note.classList.toggle("error", error);
  };
  const MODIFIERS = new Set(["Meta", "Control", "Alt", "Shift"]);
  const keyName = (e) => {
    if (e.code === "Space") return "Space";
    if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3);
    if (/^Digit\d$/.test(e.code)) return e.code.slice(5);
    if (/^F\d{1,2}$/.test(e.code)) return e.code;
    return e.key.length === 1 ? e.key.toUpperCase() : e.key;
  };

  field.addEventListener("keydown", (e) => {
    if (e.key === "Tab") return;
    e.preventDefault();
    if (MODIFIERS.has(e.key)) return;
    const mods = [e.metaKey && "Command", e.ctrlKey && "Control", e.altKey && "Alt", e.shiftKey && "Shift"].filter(Boolean);
    if (mods.length === 0) return say("Hold Command, Control, Alt or Shift with the key.", true);
    field.value = [...mods, keyName(e)].join("+");
    say("Press Save to use it.");
  });
  document.getElementById("save").addEventListener("click", async () => {
    const r = await window.sf.ask("settings:set", field.value);
    if (r?.ok) say(`${r.accelerator} opens the quick-add box.`);
    else say(r?.message ?? "Not saved.", true);
  });
  void window.sf.ask("settings:get").then((r) => {
    field.value = r?.shortcut ?? "";
    say(r?.shortcut ? "" : "No shortcut is registered: press one and Save.", r?.shortcut == null);
  });
})();
