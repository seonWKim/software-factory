// Reads the operator's identity keys from this machine: git user.email, then the OS user name.

import { execFileSync } from "node:child_process";
import { userInfo } from "node:os";
import type { LocalEnvironment } from "./local-identity.js";

export function readLocalEnvironment(cwd: string): LocalEnvironment {
  let gitEmail: string | null = null;
  try {
    gitEmail = execFileSync("git", ["config", "user.email"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    gitEmail = null;
  }
  let osUser: string | null = null;
  try {
    osUser = userInfo().username || null;
  } catch {
    osUser = null;
  }
  return { gitEmail, osUser };
}
