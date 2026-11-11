// The preload of the shell's panels (the quick-add box and the shortcut settings view). Runs sandboxed (CommonJS,
// as sandboxed preloads must) and gives the page `window.sf` with only the channels the panels use; the page gets
// no other Electron or Node API. The dashboard window keeps its own preload, which exposes nothing.
"use strict";
const { contextBridge, ipcRenderer } = require("electron");

const ASK = new Set(["quick-add:preview", "quick-add:key", "settings:get", "settings:set"]);
const HEAR = new Set(["quick-add:opened"]);

contextBridge.exposeInMainWorld("sf", {
  ask: (channel, ...args) => (ASK.has(channel) ? ipcRenderer.invoke(channel, ...args) : Promise.reject(new Error(`unknown channel ${channel}`))),
  on: (channel, fn) => {
    if (HEAR.has(channel)) ipcRenderer.on(channel, () => fn());
  },
});
