// The quick-add box's page: shows the parsed fields as chips while typing and hands Enter and Esc to the main
// process (quick-add.js), which posts the task. It holds no task logic and no token.
"use strict";
(() => {
  const input = document.getElementById("words");
  const chips = document.getElementById("chips");
  const note = document.getElementById("note");
  const say = (text, error = false) => {
    note.textContent = text ?? "";
    note.classList.toggle("error", error);
  };
  const show = (list) => chips.replaceChildren(...list.map((c) => Object.assign(document.createElement("li"), { textContent: c.text, title: c.field })));

  input.addEventListener("input", async () => {
    const r = await window.sf.ask("quick-add:preview", input.value);
    show(r?.chips ?? []);
    say(r?.problem ?? "");
  });
  input.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter" && e.key !== "Escape") return;
    e.preventDefault();
    if (e.key === "Enter") say("Adding…");
    const r = await window.sf.ask("quick-add:key", e.key, input.value);
    if (r?.error) say(r.error, true);
  });
  window.sf.on("quick-add:opened", () => {
    input.value = "";
    show([]);
    say("");
    input.focus();
  });
})();
