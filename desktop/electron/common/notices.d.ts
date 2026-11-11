import type { ShellFs } from "./app-data.js";
import type { Fetch } from "./status.js";
/** A pending notice as GET /api/v1/notices lists it. */
export interface PendingNotice {
  readonly work_item_id: string | null;
  readonly wait_key: string;
  readonly kind: string;
  readonly count: number;
  readonly created_at?: string;
}
export declare const NOTICE_TITLE: string;
export declare function noticesUrl(port: number): string;
export declare function noticeText(n: PendingNotice): { title: string; body: string };
export declare function noticeTarget(n: PendingNotice, dashboard: string): string;
export declare function noticePoller(o: {
  fetch: Fetch;
  url: string;
  dashboard: string;
  fs: Pick<ShellFs, "readFileSync" | "writeFileSync">;
  file: string;
  notify: (title: string, body: string, target: string) => void;
}): () => Promise<void>;
