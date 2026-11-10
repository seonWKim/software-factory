// The setup progress record (issue #501): `<state_dir>/setup-progress.json`, written after each finished step
// so an interrupted `factory setup` continues where it stopped. It holds step names and the GitHub answer (which a
// declined config diff leaves unwritten), never a secret value. A finished setup deletes it.

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface SetupProgress {
  /** Names of the steps that finished (✓), in the order they ran. */
  done: string[];
  /** The Plugins step's GitHub answer, when that step ran. */
  github?: boolean;
}

export const progressFile = (stateDir: string): string => join(stateDir, "setup-progress.json");

/** The record, or null when there is none or it cannot be read (setup then starts at step 1). */
export async function readProgress(stateDir: string): Promise<SetupProgress | null> {
  try {
    const raw = JSON.parse(await readFile(progressFile(stateDir), "utf8")) as Partial<SetupProgress>;
    if (!Array.isArray(raw.done) || !raw.done.every((d) => typeof d === "string")) return null;
    return { done: raw.done, ...(typeof raw.github === "boolean" ? { github: raw.github } : {}) };
  } catch {
    return null;
  }
}

export async function writeProgress(stateDir: string, p: SetupProgress): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const file = progressFile(stateDir);
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(p)}\n`, { mode: 0o600 });
  await rename(tmp, file);
}

export async function clearProgress(stateDir: string): Promise<void> {
  await rm(progressFile(stateDir), { force: true });
}
