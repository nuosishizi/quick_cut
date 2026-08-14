import SwiftUI
import WebKit
import AppKit

@MainActor
final class EditorHostModel: ObservableObject {
    @Published var editorURL: URL?
    @Published var status: String = "正在准备视频剪辑模块…"
    @Published var failed = false

    private var process: Process?
    private var outputPipe: Pipe?
    private var stderrPipe: Pipe?
    private var buffer = ""

    func startIfNeeded() {
        if process?.isRunning == true || editorURL != nil { return }
        failed = false
        status = "正在启动视频剪辑…"

        guard let resources = Bundle.main.resourceURL else {
            fail("找不到快剪资源目录。")
            return
        }
        let runtime = resources.appendingPathComponent("EditorRuntime", isDirectory: true)
        let bun = runtime.appendingPathComponent("runtime/bun-arm64")
        let script = runtime.appendingPathComponent("editor-desktop/src/main.mjs")
        let media = runtime.appendingPathComponent("media", isDirectory: true)

        guard FileManager.default.isExecutableFile(atPath: bun.path),
              FileManager.default.fileExists(atPath: script.path) else {
            fail("视频剪辑运行组件没有正确打包，请重新运行一键生成 APP。")
            return
        }

        let task = Process()
        let stdout = Pipe()
        let stderr = Pipe()
        task.executableURL = bun
        task.arguments = [script.path]
        task.currentDirectoryURL = runtime.appendingPathComponent("editor-desktop", isDirectory: true)
        var env = ProcessInfo.processInfo.environment
        env["QUICKCUT_MEDIA_ROOT"] = media.path
        env["QUICKCUT_APP_EXECUTABLE"] = Bundle.main.executableURL?.path ?? ""
        env["QUICKCUT_SUPPORT_ROOT"] = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/QuickCut", isDirectory: true).path
        task.environment = env
        task.standardOutput = stdout
        task.standardError = stderr

        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            Task { @MainActor in self?.consume(text) }
        }
        stderr.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            NSLog("[快剪视频剪辑] %@", text)
        }
        task.terminationHandler = { [weak self] task in
            Task { @MainActor in
                guard let self else { return }
                self.process = nil
                if task.terminationStatus != 0 && self.editorURL == nil {
                    self.fail("视频剪辑后台启动失败（代码 \(task.terminationStatus)）。")
                }
            }
        }

        do {
            try task.run()
            process = task
            outputPipe = stdout
            stderrPipe = stderr
        } catch {
            fail("无法启动视频剪辑后台：\(error.localizedDescription)")
        }
    }

    private func consume(_ text: String) {
        buffer += text
        while let range = buffer.range(of: "\n") {
            let line = String(buffer[..<range.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
            buffer.removeSubrange(...range.lowerBound)
            if line.hasPrefix("QUICKCUT_EMBED_PORT="),
               let port = Int(line.replacingOccurrences(of: "QUICKCUT_EMBED_PORT=", with: "")),
               let url = URL(string: "http://127.0.0.1:\(port)/") {
                editorURL = url
                status = "视频剪辑已就绪"
                failed = false
            }
        }
    }

    func waitUntilReady() async throws {
        startIfNeeded()
        let deadline = Date().addingTimeInterval(25)
        while editorURL == nil && !failed && Date() < deadline {
            try await Task.sleep(nanoseconds: 120_000_000)
        }
        if let editorURL { _ = editorURL; return }
        throw NSError(domain: "EditorHost", code: 1, userInfo: [NSLocalizedDescriptionKey: status])
    }

    func rpc(_ name: String, args: [Any], timeout: TimeInterval = 120) async throws -> Any {
        try await waitUntilReady()
        guard let base = editorURL, let endpoint = URL(string: "rpc/\(name)", relativeTo: base)?.absoluteURL else {
            throw NSError(domain: "EditorHost", code: 2, userInfo: [NSLocalizedDescriptionKey: "视频处理后台尚未就绪。"] )
        }
        var request = URLRequest(url: endpoint, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: args)
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw NSError(domain: "EditorHost", code: 3, userInfo: [NSLocalizedDescriptionKey: "后台没有返回有效响应。"] )
        }
        let value = try JSONSerialization.jsonObject(with: data)
        if http.statusCode >= 400 {
            if let dict = value as? [String: Any], let error = dict["error"] as? [String: Any], let message = error["message"] as? String {
                throw NSError(domain: "EditorHost", code: http.statusCode, userInfo: [NSLocalizedDescriptionKey: message])
            }
            throw NSError(domain: "EditorHost", code: http.statusCode, userInfo: [NSLocalizedDescriptionKey: "后台处理失败。"] )
        }
        if let dict = value as? [String: Any], let ok = dict["ok"] as? Bool {
            if ok, dict.keys.contains("value") { return dict["value"] as Any }
            if !ok, let error = dict["error"] as? [String: Any], let message = error["message"] as? String {
                throw NSError(domain: "EditorHost", code: 4, userInfo: [NSLocalizedDescriptionKey: message])
            }
        }
        return value
    }

    func restart() {
        stop()
        editorURL = nil
        buffer = ""
        startIfNeeded()
    }

    func stop() {
        outputPipe?.fileHandleForReading.readabilityHandler = nil
        stderrPipe?.fileHandleForReading.readabilityHandler = nil
        if process?.isRunning == true { process?.terminate() }
        process = nil
        outputPipe = nil
        stderrPipe = nil
    }

    private func fail(_ message: String) {
        status = message
        failed = true
    }

    deinit {
        if process?.isRunning == true { process?.terminate() }
    }
}

struct EditorLauncherView: View {
    @ObservedObject var model: EditorHostModel

    var body: some View {
        ZStack {
            Color(nsColor: .windowBackgroundColor).ignoresSafeArea()
            if let url = model.editorURL {
                EmbeddedEditorWebView(url: url)
            } else {
                VStack(spacing: 16) {
                    ProgressView().controlSize(.large)
                    Text(model.failed ? "视频剪辑启动失败" : "正在启动视频剪辑")
                        .font(.title3.bold())
                    Text(model.status)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                    if model.failed {
                        Button("重新启动") { model.restart() }
                            .buttonStyle(.borderedProminent)
                    }
                }
                .padding(28)
            }
        }
        .onAppear { model.startIfNeeded() }
    }
}

private struct EmbeddedEditorWebView: NSViewRepresentable {
    let url: URL

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.allowsMagnification = false
        webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
        context.coordinator.lastURL = url
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        if context.coordinator.lastURL != url {
            context.coordinator.lastURL = url
            webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
        }
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var lastURL: URL?
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            if let target = navigationAction.request.url,
               let host = target.host,
               host != "127.0.0.1" && host != "localhost",
               navigationAction.navigationType == .linkActivated {
                NSWorkspace.shared.open(target)
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }
    }
}
