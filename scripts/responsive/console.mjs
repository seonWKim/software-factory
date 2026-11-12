// What a page logs while `npm run check:responsive` looks at it: console messages of level error, error-level log
// entries (a CSP violation, a resource the browser refused), failed requests and 4xx/5xx responses. Any one fails
// the check. Fed the DevTools events by scripts/responsive/cdp.mjs; pure, so tests/responsive-console.test.ts
// drives it with injected events.

/**
 * 4xx/5xx responses a page's seeded state expects, by URL substring, each with a one-line reason. List a URL here
 * rather than loosening the rule.
 */
export const EXPECTED_HTTP_ERRORS = [];

/** The DevTools events record() reads; Page subscribes to each. */
export const CONSOLE_EVENTS = [
  "Runtime.consoleAPICalled",
  "Log.entryAdded",
  "Network.requestWillBeSent",
  "Network.responseReceived",
  "Network.loadingFailed",
];

const argText = (a) => (a.value !== undefined ? String(a.value) : (a.unserializableValue ?? a.description ?? a.type));

export class ConsoleLog {
  #expected;
  #urls = new Map(); // requestId -> URL, so a failed request can name what failed
  #found = [];

  constructor(expected = EXPECTED_HTTP_ERRORS) {
    this.#expected = expected;
  }

  #isExpected(url) {
    return url !== undefined && this.#expected.some((e) => url.includes(e.url));
  }

  record(method, p) {
    switch (method) {
      case "Runtime.consoleAPICalled":
        if (p.type === "error") this.#found.push(`console.error: ${(p.args ?? []).map(argText).join(" ")}`);
        return;
      case "Log.entryAdded": {
        const e = p.entry;
        if (e.level === "error" && !this.#isExpected(e.url)) this.#found.push(`log ${e.source}: ${e.text}${e.url ? ` (${e.url})` : ""}`);
        return;
      }
      case "Network.requestWillBeSent":
        this.#urls.set(p.requestId, p.request.url);
        return;
      case "Network.responseReceived": {
        const { url, status } = p.response;
        if (status >= 400 && !this.#isExpected(url)) this.#found.push(`HTTP ${status}: ${url}`);
        return;
      }
      case "Network.loadingFailed": {
        const url = this.#urls.get(p.requestId) ?? "(unknown URL)";
        this.#urls.delete(p.requestId);
        // A poll cut off by the next navigation is cancelled, not refused; a blocked one carries blockedReason.
        if (p.canceled && !p.blockedReason) return;
        this.#found.push(`request failed: ${p.errorText}${p.blockedReason ? ` (blocked: ${p.blockedReason})` : ""}: ${url}`);
        return;
      }
    }
  }

  /** The failures recorded since the last take(), and forgets them. */
  take() {
    const found = this.#found;
    this.#found = [];
    return found;
  }
}
