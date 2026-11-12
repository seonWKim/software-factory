// The console collection of `npm run check:responsive` (scripts/responsive/console.mjs): which DevTools events
// fail the check. Driven with injected events, no browser.
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

interface ConsoleLogCtor {
  new (expected?: { url: string; reason: string }[]): {
    record(method: string, params: unknown): void;
    take(): string[];
  };
}
const { ConsoleLog, CONSOLE_EVENTS } = (await import(pathToFileURL(join(ROOT, "scripts", "responsive", "console.mjs")).href)) as {
  ConsoleLog: ConsoleLogCtor;
  CONSOLE_EVENTS: string[];
};

const URL_ = "http://127.0.0.1:4000/app/favicon.png";

describe("check:responsive console collection", () => {
  it("listens to the console, the log and the network", () => {
    for (const e of ["Runtime.consoleAPICalled", "Log.entryAdded", "Network.loadingFailed", "Network.responseReceived"]) {
      expect(CONSOLE_EVENTS).toContain(e);
    }
  });

  it("an error-level console message is a failure naming its message", () => {
    const log = new ConsoleLog();
    log.record("Runtime.consoleAPICalled", { type: "error", args: [{ type: "string", value: "boom" }, { type: "number", value: 2 }] });
    const found = log.take();
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("boom 2");
    expect(log.take()).toEqual([]);
  });

  it("an error-level log entry (a CSP violation) is a failure naming its text", () => {
    const log = new ConsoleLog();
    log.record("Log.entryAdded", {
      entry: { level: "error", source: "security", text: "Refused to load the image because it violates the CSP", url: URL_ },
    });
    expect(log.take()[0]).toContain("Refused to load the image");
  });

  it("a failed request is a failure naming its URL and error", () => {
    const log = new ConsoleLog();
    log.record("Network.requestWillBeSent", { requestId: "1", request: { url: URL_ } });
    log.record("Network.loadingFailed", { requestId: "1", errorText: "net::ERR_BLOCKED_BY_CLIENT", blockedReason: "csp", canceled: false });
    const found = log.take();
    expect(found).toHaveLength(1);
    expect(found[0]).toContain(URL_);
    expect(found[0]).toContain("net::ERR_BLOCKED_BY_CLIENT");
  });

  it("a 4xx or 5xx response is a failure unless its URL is listed as expected", () => {
    const log = new ConsoleLog([{ url: "/api/v1/items/missing", reason: "the not-found page" }]);
    log.record("Network.responseReceived", { requestId: "1", response: { url: "http://h/api/v1/overview", status: 500 } });
    log.record("Network.responseReceived", { requestId: "2", response: { url: "http://h/api/v1/items/missing", status: 404 } });
    log.record("Log.entryAdded", { entry: { level: "error", source: "network", text: "404", url: "http://h/api/v1/items/missing" } });
    log.record("Network.responseReceived", { requestId: "3", response: { url: "http://h/api/v1/overview", status: 200 } });
    const found = log.take();
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("500");
  });

  it("a warning, an info log entry and a request cancelled by navigation are not failures", () => {
    const log = new ConsoleLog();
    log.record("Runtime.consoleAPICalled", { type: "warning", args: [{ type: "string", value: "careful" }] });
    log.record("Log.entryAdded", { entry: { level: "warning", source: "other", text: "careful" } });
    log.record("Log.entryAdded", { entry: { level: "verbose", source: "violation", text: "slow handler" } });
    log.record("Network.requestWillBeSent", { requestId: "1", request: { url: "http://h/api/v1/overview" } });
    log.record("Network.loadingFailed", { requestId: "1", errorText: "net::ERR_ABORTED", canceled: true });
    expect(log.take()).toEqual([]);
  });
});
