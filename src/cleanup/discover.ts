// Handler discovery (design 08-cleanup): every `<name>.cleanup.ts` under src/cleanup/handlers/, one folder each,
// loaded once per process and sorted by removal order. A file whose default export is not defineCleanupHandler fails.

import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findDescriptorFiles, forgetOnFailure } from "../state/index.js";
import { type CleanupHandlerDescriptor, HANDLER_FILE } from "./handler.js";

export const HANDLERS_DIR = join(dirname(fileURLToPath(import.meta.url)), "handlers");

let loaded: Promise<CleanupHandlerDescriptor[]> | null = null;

/** The handlers under `dir`, by order then name. */
export async function discoverHandlers(dir: string = HANDLERS_DIR): Promise<CleanupHandlerDescriptor[]> {
  const out: CleanupHandlerDescriptor[] = [];
  for (const file of findDescriptorFiles(dir, HANDLER_FILE)) {
    const mod = (await import(pathToFileURL(file).href)) as { default?: Partial<CleanupHandlerDescriptor> };
    if (mod.default?.kind !== "cleanup") throw new Error(`${relative(dir, file)}: default export must be defineCleanupHandler(...)`);
    out.push(mod.default as CleanupHandlerDescriptor);
  }
  return out.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

/** The discovered handlers, loaded once per process (a failed load is tried again). */
export function cleanupHandlers(): Promise<CleanupHandlerDescriptor[]> {
  return (loaded ??= forgetOnFailure(discoverHandlers(), () => (loaded = null)));
}
