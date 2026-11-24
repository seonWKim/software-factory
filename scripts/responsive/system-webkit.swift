// The macOS system WebKit (the engine of Safari and the cmux browser) for `npm run check:responsive`, offscreen.
// Reads a JSON array of jobs { url, width, height, dark, js } from the file named by its one argument; for each, loads
// the url in a WKWebView of that size and appearance, runs `js` (an async function body) and prints its result as one
// line. Compiled and run by system-webkit.mjs.
import AppKit
import WebKit

struct Job: Decodable { let url: String; let width: Double; let height: Double; let dark: Bool; let js: String }

let jobs = try! JSONDecoder().decode([Job].self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
let app = NSApplication.shared
// No Dock icon and no focus taken: a background helper.
app.setActivationPolicy(.prohibited)
let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 800), styleMask: [.borderless], backing: .buffered, defer: false)
let view = WKWebView(frame: window.contentView!.bounds)
window.contentView!.addSubview(view)

final class Runner: NSObject, WKNavigationDelegate {
  var next = 0
  /** Prints the job's result and starts the next one, once per job (a load or a script that hangs times out). */
  func finish(_ index: Int, _ line: String) {
    guard index == next else { return }
    print(line)
    fflush(stdout)
    next += 1
    start()
  }
  func start() {
    guard next < jobs.count else { exit(0) }
    let job = jobs[next]
    let index = next
    DispatchQueue.main.asyncAfter(deadline: .now() + 20) { self.finish(index, "{\"error\":\"timed out after 20s\"}") }
    window.setContentSize(NSSize(width: job.width, height: job.height))
    view.frame = NSRect(x: 0, y: 0, width: job.width, height: job.height)
    view.appearance = NSAppearance(named: job.dark ? .darkAqua : .aqua)
    view.load(URLRequest(url: URL(string: job.url)!))
  }
  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    let (job, index) = (jobs[next], next)
    // The page's reads settle after the load event.
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
      webView.callAsyncJavaScript(job.js, arguments: [:], in: nil, in: .page) { result in
        switch result {
        case .success(let value): self.finish(index, value as? String ?? "null")
        case .failure(let error): self.finish(index, "{\"error\":\(String(reflecting: error.localizedDescription))}")
        }
      }
    }
  }
}

let runner = Runner()
view.navigationDelegate = runner
runner.start()
app.run()
