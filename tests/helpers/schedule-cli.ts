// Shared setup for the `factory schedule …` CLI tests (design 08-schedules): the owner, the clock constants, the CLI
// runner and the stored-schedule readers.

import { type CliAction, type LocalCliDeps, parseLocalCliArgs, runLocalCli } from "../../src/core/local-cli.js";
import type { ScheduleStore } from "../../src/core/schedule.js";
import type { Timestamp, UserId } from "../../src/core/types.js";
import { FakeClock } from "../../src/impl/clock/fake-clock.js";
import { answers } from "./local-cli.js";
import { PROJECT_KEY, newStore } from "./store.js";

export const OWNER = "local:owner@example.com" as UserId;
export const HOUR = 3_600_000;
export const START = "2026-11-22T12:00:00.000Z"; // 21:00 Seoul: a daily 09:00 Seoul schedule is first due 2026-11-23 00:00Z
export const FIRST = "2026-11-23T00:00:00.000Z" as Timestamp;
export const ADD = ["add", "--id", "sch_fb", "--title", "Feedback", "--cadence", "daily", "--spec", "09:00", "--zone", "Asia/Seoul", "--action", "build"];

export async function setup(extra: Partial<LocalCliDeps> = {}) {
  const clock = new FakeClock(START);
  const { store } = await newStore(clock);
  const d = (user: UserId): LocalCliDeps => ({ store, identity: { user, from: "cli_user" }, project: async () => PROJECT_KEY, read: async () => "", newId: () => "id", answers, ...extra });
  /** `factory schedule <args>` as `user` (the owner unless given). */
  const cli = (args: string[], user: UserId = OWNER) => {
    const a = parseLocalCliArgs("schedule", args);
    if ("error" in a) throw new Error(a.error);
    return runLocalCli(d(user), a as CliAction);
  };
  return { clock, store, cli };
}

export const stored = async (store: ScheduleStore) => (await store.listSchedules()).find((s) => s.id === "sch_fb");

// Check a page schedules: the routine's fields through `schedule add` and `edit`.
export const PAGE = ["add", "--id", "cp_1", "--title", "Docs page", "--action", "check-page", "--url", "https://example.com/docs", "--instruction", "Find broken links"];
export const DAILY_PAGE = [...PAGE, "--cadence", "daily", "--spec", "09:00", "--zone", "Asia/Seoul"];
export const MERGE_PAGE = [...PAGE, "--cadence", "on-merge"];
export const page = async (store: ScheduleStore, id = "cp_1") => (await store.listCheckPages()).find((s) => s.id === id);
