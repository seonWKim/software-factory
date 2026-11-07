// A fake OpenAI-style HTTP server on 127.0.0.1. It serves scripted responses in order, records every request
// (method, path, headers, body) and marks a request `cancelled` when the client disconnects before a response.

import { type IncomingHttpHeaders, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";

export type ScriptedResponse =
  | { status: number; body?: unknown; headers?: Record<string, string> }
  /** Never answer: the request stays open until the client goes away. */
  | { hang: true }
  /** Read the request, then destroy the socket with no response: a network error for the client. */
  | { destroy: true };

export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
  /** The client disconnected before a response was sent. */
  cancelled: boolean;
}

export interface FakeOpenAIServer {
  /** e.g. "http://127.0.0.1:54321/v1" */
  baseUrl: string;
  /** "http://127.0.0.1:54321" */
  origin: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

/** A 200 chat completion body. */
export function completion(opts: {
  text?: string | null;
  tool_calls?: unknown[];
  model?: string;
  prompt_tokens?: number;
  completion_tokens?: number;
} = {}): unknown {
  return {
    id: "chatcmpl-1",
    object: "chat.completion",
    model: opts.model ?? "fake-model-1",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: opts.text === undefined ? "hello" : opts.text, ...(opts.tool_calls ? { tool_calls: opts.tool_calls } : {}) },
        finish_reason: opts.tool_calls ? "tool_calls" : "stop",
      },
    ],
    usage: { prompt_tokens: opts.prompt_tokens ?? 11, completion_tokens: opts.completion_tokens ?? 7, total_tokens: (opts.prompt_tokens ?? 11) + (opts.completion_tokens ?? 7) },
  };
}

export async function startFakeOpenAIServer(script: ScriptedResponse[]): Promise<FakeOpenAIServer> {
  const queue = [...script];
  const requests: RecordedRequest[] = [];
  const open = new Set<ServerResponse>();
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const rec: RecordedRequest = {
        method: req.method ?? "",
        path: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
        cancelled: false,
      };
      requests.push(rec);
      open.add(res);
      res.on("close", () => {
        open.delete(res);
        if (!res.writableFinished) rec.cancelled = true;
      });
      const next = queue.shift() ?? { status: 500, body: { error: { message: "fake server: no scripted response left" } } };
      if ("hang" in next) return;
      if ("destroy" in next) {
        req.socket.destroy();
        return;
      }
      const body = next.body === undefined ? "" : typeof next.body === "string" ? next.body : JSON.stringify(next.body);
      res.writeHead(next.status, { "content-type": "application/json", ...next.headers });
      res.end(body);
    });
  });
  // A bind failure (e.g. a sandbox that forbids listening) rejects here instead of surfacing later.
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    baseUrl: `${origin}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        for (const res of open) res.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
