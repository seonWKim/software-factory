import type { TaskFields } from "../../../src/core/tasks.js";
export type PostFetch = (
  url: string,
  init?: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
export type PostResult = { ok: true; task: Record<string, unknown> } | { ok: false; message: string };
export type PostTask = (body: { id: string; words: string }) => Promise<PostResult>;
export interface Chip {
  field: "due" | "time" | "priority" | "list" | "recurrence";
  text: string;
}
export declare const tasksUrl: (port: number) => string;
export declare const sessionUrl: (port: number) => string;
export declare function taskPoster(o: { fetch: PostFetch; port: number }): PostTask;
export declare function fieldChips(fields: TaskFields): Chip[];
