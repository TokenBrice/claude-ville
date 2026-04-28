import Cocoa
import WebKit

// MARK: - App Delegate

class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    var popover: NSPopover!
    var webView: WKWebView!
    var serverProcess: Process?
    var ownsServer = false
    var dashboardWindow: NSWindow?
    var dashboardWebView: WKWebView?
    var pollTimer: Timer?
    var lastHTML: String = ""
    var lastRenderSignature: String = ""
    var isFetching = false
    var fetchGeneration = 0
    let serverBase = "http://localhost:4000"

    func applicationDidFinishLaunching(_ notification: Notification) {
        setupStatusItem()
        setupPopover()
        DispatchQueue.global(qos: .utility).async {
            let ready = self.startServerIfNeeded()
            DispatchQueue.main.async {
                if !ready { self.renderOffline() }
                self.startPolling()
            }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        pollTimer?.invalidate()
        stopServer()
    }

    // MARK: - Poll the REST API to refresh the badge and popover HTML

    func startPolling() {
        fetchAndRender()
        pollTimer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { [weak self] _ in
            self?.fetchAndRender()
        }
    }

    func fetchAndRender() {
        if isFetching { return }

        guard let sessionsURL = URL(string: "\(serverBase)/api/sessions"),
              let usageURL = URL(string: "\(serverBase)/api/usage") else {
            renderOffline(); return
        }

        isFetching = true
        fetchGeneration += 1
        let generation = fetchGeneration

        let group = DispatchGroup()
        var sessionsResult: [[String: Any]]?
        var usageResult: [String: Any]?

        group.enter()
        URLSession.shared.dataTask(with: sessionsURL) { data, _, error in
            defer { group.leave() }
            guard let data = data, error == nil,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let sessions = json["sessions"] as? [[String: Any]] else { return }
            sessionsResult = sessions
        }.resume()

        group.enter()
        URLSession.shared.dataTask(with: usageURL) { data, _, error in
            defer { group.leave() }
            guard let data = data, error == nil,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
            usageResult = json
        }.resume()

        group.notify(queue: .main) { [weak self] in
            guard let self = self else { return }
            guard generation == self.fetchGeneration else {
                self.isFetching = false
                return
            }

            self.isFetching = false
            guard let sessions = sessionsResult else {
                self.renderOffline(); return
            }
            self.renderSessions(sessions, usage: usageResult)
        }
    }

    func renderOffline() {
        if lastRenderSignature == "offline" { return }
        lastRenderSignature = "offline"
        updateBadge(working: 0)
        let html = Self.buildHTML(agents: [], working: 0, idle: 0, tokens: "0", cost: "$0.00", offline: true)
        if html != lastHTML { lastHTML = html; webView.loadHTMLString(html, baseURL: nil) }
    }

    func renderSessions(_ sessions: [[String: Any]], usage: [String: Any]? = nil) {
        let sortedSessions = sessions.sorted { (left, right) -> Bool in
            let leftStatus = Self.normalizeStatus(left["status"] as? String)
            let rightStatus = Self.normalizeStatus(right["status"] as? String)
            let order: [String: Int] = ["working": 0, "waiting": 1, "idle": 2]
            return (order[leftStatus] ?? 9) < (order[rightStatus] ?? 9)
        }

        var agents: [(name: String, model: String, modelColor: String, status: String)] = []
        var working = 0, idle = 0, totalTokens = 0, totalCost: Double = 0
        var signatureParts: [String] = []

        for s in sortedSessions {
            let status = Self.normalizeStatus(s["status"] as? String)
            let name = (s["name"] as? String)
                ?? (s["sessionId"] as? String)?.prefix(8).description
                ?? "Unknown"
            let rawModel = s["model"] as? String ?? "?"
            let effort = (s["reasoningEffort"] as? String) ?? (s["effort"] as? String)
            let provider = s["provider"] as? String
            let model = Self.modelLabel(rawModel, effort: effort, provider: provider)
            let modelColor = Self.modelColor(rawModel, provider: provider)
            if status == "working" { working += 1 } else { idle += 1 }
            let tokenSource = s["tokenUsage"] as? [String: Any]
                ?? s["tokens"] as? [String: Any]
                ?? s["usage"] as? [String: Any]
            let normalizedUsage = Self.normalizeTokenUsage(tokenSource)
            let sessionTokens = normalizedUsage.input + normalizedUsage.output + normalizedUsage.cacheRead + normalizedUsage.cacheCreate
            totalTokens += sessionTokens

            let estimatedCost = Self.toDouble(s["estimatedCost"]) ?? -1
            let isEstimatedFinite = estimatedCost.isFinite && estimatedCost >= 0
            let sessionCost = isEstimatedFinite
                ? estimatedCost
                : Self.estimateTokenCost(tokenSource, model: rawModel, provider: provider)

            totalCost += sessionCost
            let signatureSessionId = (s["sessionId"] as? String)
                ?? (s["id"] as? String)
                ?? String(signatureParts.count)
            signatureParts.append("\(signatureSessionId)|\(status)|\(model)|\(sessionTokens)|\(String(format: "%.6f", sessionCost))")
            agents.append((name: name, model: model, modelColor: modelColor, status: status))
        }

        let account = usage?["account"] as? [String: Any]
        let activity = usage?["activity"] as? [String: Any]
        let today = activity?["today"] as? [String: Any]
        let quota = usage?["quota"] as? [String: Any]
        let msgs = Self.toInt(today?["messages"])
        let sessions = Self.toInt(today?["sessions"])
        let fiveHour = Self.toDouble(quota?["fiveHour"]) ?? 0
        let sevenDay = Self.toDouble(quota?["sevenDay"]) ?? 0

        let quotaSignature = [
            usage?["quotaAvailable"] as? Bool == true ? "1" : "0",
            account?["rateLimitTier"] as? String ?? "",
            account?["subscriptionType"] as? String ?? "",
            String(msgs),
            String(sessions),
            String(fiveHour),
            String(sevenDay),
        ].joined(separator: "|")

        let renderSignature = "\(sortedSessions.count)|\(working)|\(idle)|\(totalTokens)|\(String(format: "%.4f", totalCost))|\(quotaSignature)|\(signatureParts.joined(separator: "||"))"
        if renderSignature == lastRenderSignature { return }
        lastRenderSignature = renderSignature

        updateBadge(working: working)
        let tokStr = totalTokens >= 1_000_000 ? String(format: "%.1fM", Double(totalTokens)/1_000_000)
                   : totalTokens >= 1000 ? String(format: "%.1fK", Double(totalTokens)/1000)
                   : "\(totalTokens)"
        let costStr = String(format: "$%.2f", totalCost)
        // Parse usage/quota
        var tierStr = ""
        var activityStr = ""
        var quotaAvailable = false
        var fiveHourPct = 0
        var sevenDayPct = 0

        if let usage = usage {
            if let account = usage["account"] as? [String: Any] {
                tierStr = Self.formatTier(
                    rateLimitTier: account["rateLimitTier"] as? String,
                    subscriptionType: account["subscriptionType"] as? String
                )
            }
            if let activity = usage["activity"] as? [String: Any],
               let today = activity["today"] as? [String: Any] {
                let msgs = Self.toInt(today["messages"])
                let sess = Self.toInt(today["sessions"])
                let msgsStr = msgs >= 1000 ? String(format: "%.1fK", Double(msgs)/1000) : "\(msgs)"
                activityStr = "\(msgsStr) msgs / \(sess) sessions"
            }
            if let qa = usage["quotaAvailable"] as? Bool, qa,
               let quota = usage["quota"] as? [String: Any] {
                quotaAvailable = true
                let rawFiveHour = max(0, Self.toDouble(quota["fiveHour"]) ?? 0)
                let rawSevenDay = max(0, Self.toDouble(quota["sevenDay"]) ?? 0)
                let normalizedFiveHour = rawFiveHour > 1 ? rawFiveHour / 100 : rawFiveHour
                let normalizedSevenDay = rawSevenDay > 1 ? rawSevenDay / 100 : rawSevenDay
                fiveHourPct = Int((max(0, min(1, normalizedFiveHour)) * 100).rounded())
                sevenDayPct = Int((max(0, min(1, normalizedSevenDay)) * 100).rounded())
            }
        }

        let html = Self.buildHTML(agents: agents, working: working, idle: idle,
                                  tokens: tokStr, cost: costStr, offline: false,
                                  tier: tierStr, activity: activityStr,
                                  quotaAvailable: quotaAvailable,
                                  fiveHourPct: fiveHourPct, sevenDayPct: sevenDayPct)
        if html != lastHTML { lastHTML = html; webView.loadHTMLString(html, baseURL: nil) }
    }

    static func formatTier(rateLimitTier: String?, subscriptionType: String?) -> String {
        if let tier = rateLimitTier {
            if let range = tier.range(of: #"max_(\d+x)"#, options: .regularExpression) {
                let matched = String(tier[range])
                let suffix = matched.replacingOccurrences(of: "max_", with: "")
                return "Max \(suffix)"
            }
        }
        if let sub = subscriptionType, !sub.isEmpty {
            return sub.prefix(1).uppercased() + sub.dropFirst()
        }
        return "Free"
    }

    static func normalizedEffort(_ effort: String?) -> String? {
        let normalized = (effort ?? "").lowercased()
        if normalized.isEmpty { return nil }
        if normalized == "none" { return "none" }
        if normalized.contains("xhigh") || normalized.contains("extra") { return "xhigh" }
        if normalized.contains("high") { return "high" }
        if normalized.contains("medium") { return "medium" }
        if normalized.contains("low") { return "low" }
        return normalized
    }

    static func modelLabel(_ model: String, effort: String?, provider: String?) -> String {
        let normalizedModel = model.lowercased()
            .replacingOccurrences(of: ".", with: "-")
            .replacingOccurrences(of: "_", with: "-")
        let normalizedProvider = (provider ?? "").lowercased()
        let base: String
        if normalizedModel.contains("gpt-5-3-codex-spark") {
            base = "5.3 Spark"
        } else if normalizedModel.contains("gpt-5-5") {
            base = "5.5"
        } else if normalizedProvider.contains("codex") || normalizedModel.contains("codex") || normalizedModel.contains("gpt") {
            base = model
        } else {
            base = model
                .replacingOccurrences(of: "claude-", with: "")
                .components(separatedBy: "-").first ?? model
        }

        guard let effort = normalizedEffort(effort), effort != "none" else { return base }
        let effortLabels = ["medium": "med"]
        return "\(base) \(effortLabels[effort] ?? effort)"
    }

    static func modelColor(_ model: String, provider: String?) -> String {
        let normalizedModel = model.lowercased()
            .replacingOccurrences(of: ".", with: "-")
            .replacingOccurrences(of: "_", with: "-")
        let normalizedProvider = (provider ?? "").lowercased()
        if normalizedModel.contains("gpt-5-3-codex-spark") { return "#f8e36f" }
        if normalizedModel.contains("gpt-5-5") { return "#fff1b8" }
        if normalizedProvider.contains("codex") || normalizedModel.contains("codex") || normalizedModel.contains("gpt") { return "#7be3d7" }
        return "#64748b"
    }

    static func buildHTML(agents: [(name: String, model: String, modelColor: String, status: String)],
                          working: Int, idle: Int, tokens: String, cost: String, offline: Bool,
                          tier: String = "", activity: String = "",
                          quotaAvailable: Bool = false,
                          fiveHourPct: Int = 0, sevenDayPct: Int = 0) -> String {
        // Runtime popover surface. widget/Resources remains bundled for the static WebSocket surface and smoke checks.
        let sorted = agents.sorted { a, b in
            let order: [String: Int] = ["working": 0, "waiting": 1, "idle": 2]
            return (order[a.status] ?? 9) < (order[b.status] ?? 9)
        }

        var rows = ""
        if offline {
            rows = """
            <div style="text-align:center;padding:40px 0;color:#f97316">
              <div style="font-size:24px;margin-bottom:8px">⚡</div>
              <div style="font-family:'Press Start 2P',monospace;font-size:10px">SERVER OFFLINE</div>
              <div style="font-size:11px;color:#64748b;margin-top:8px">Reconnecting...</div>
            </div>
            """
        } else if sorted.isEmpty {
            rows = """
            <div style="text-align:center;padding:40px 0;color:#64748b">
              <div style="font-size:11px">No agents</div>
            </div>
            """
        } else {
            for a in sorted {
                let isWorking = a.status == "working"
                let isWaiting = a.status == "waiting"
                let isIdle = a.status == "idle"
                let dotColor = isWorking ? "#4ade80" : isWaiting ? "#f59e0b" : "#60a5fa"
                let statusText = isWorking ? "Working..." : isWaiting ? "Waiting..." : isIdle ? "Idle" : "Idle"
                let opacity = isWaiting || isWorking ? "1" : "0.6"
                rows += """
                <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;opacity:\(opacity)">
                  <span style="color:\(dotColor);font-size:8px">●</span>
                  <span style="flex:1;font-size:12px;color:#e2e8f0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\(escHTML(a.name))</span>
                  <span style="font-size:9px;color:\(escHTML(a.modelColor));font-family:monospace">\(escHTML(a.model))</span>
                  <span style="font-size:10px;color:\(dotColor)">\(statusText)</span>
                </div>
                """
            }
        }

        return """
        <!DOCTYPE html>
        <html><head>
        <meta charset="UTF-8">
        <link href="https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap" rel="stylesheet">
        <style>
          * { margin:0; padding:0; box-sizing:border-box; }
          body { background:#0a0a0f; color:#e2e8f0; font-family:-apple-system,sans-serif;
                 width:320px; height:420px; overflow:hidden; }
          .header { padding:16px; border-bottom:1px solid #1e293b; }
          .title { font-family:'Press Start 2P',monospace; font-size:12px; color:#a78bfa;
                   margin-bottom:12px; }
          .badges { display:flex; gap:16px; margin-bottom:8px; }
          .badge { display:flex; align-items:center; gap:4px; font-size:12px; }
          .meta { display:flex; justify-content:space-between; font-size:11px; color:#64748b; }
          .quota-sec { padding:8px 16px; border-bottom:1px solid #1e293b; display:flex;
                       justify-content:space-between; align-items:center; flex-wrap:wrap; gap:4px; }
          .q-tier { font-size:9px; padding:2px 6px; border-radius:3px;
                    background:rgba(167,139,250,0.15); color:#a78bfa; font-weight:600; }
          .q-act { font-size:10px; color:#64748b; }
          .q-bars { display:flex; gap:8px; width:100%; margin-top:4px; }
          .q-bar { display:flex; align-items:center; gap:3px; flex:1; }
          .q-lbl { font-size:8px; color:#64748b; width:16px; }
          .q-track { flex:1; height:5px; background:rgba(255,255,255,0.08); border-radius:3px; overflow:hidden; }
          .q-fill { height:100%; border-radius:3px; transition:width 0.3s; }
          .q-pct { font-size:8px; color:#64748b; width:22px; text-align:right; }
          .list { flex:1; overflow-y:auto; }
          .list::-webkit-scrollbar { width:4px; }
          .list::-webkit-scrollbar-thumb { background:#334155; border-radius:2px; }
          .footer { padding:12px; border-top:1px solid #1e293b; text-align:center; }
          .btn { background:none; border:1px solid #334155; color:#a78bfa; padding:8px 16px;
                 border-radius:6px; cursor:pointer; font-size:11px; width:100%; }
          .btn:hover { background:#1e1e2e; border-color:#a78bfa; }
          .wrap { display:flex; flex-direction:column; height:100%; }
        </style>
        </head><body>
        <div class="wrap">
          <div class="header">
            <div class="title">ClaudeVille</div>
            <div class="badges">
              <div class="badge"><span style="color:#4ade80">●</span> \(working) working</div>
              <div class="badge"><span style="color:#60a5fa">●</span> \(idle) idle</div>
            </div>
            <div class="meta">
              <span>\(tokens) tokens</span>
              <span>\(cost)</span>
            </div>
          </div>
          \(Self.buildQuotaSection(tier: tier, activity: activity, quotaAvailable: quotaAvailable, fiveHourPct: fiveHourPct, sevenDayPct: sevenDayPct))
          <div class="list">\(rows)</div>
          <div class="footer">
            <button class="btn" onclick="try{webkit.messageHandlers.openDashboard.postMessage({})}catch(e){}">
              Open Dashboard ↗
            </button>
          </div>
        </div>
        </body></html>
        """
    }

    static func buildQuotaSection(tier: String, activity: String,
                                      quotaAvailable: Bool,
                                      fiveHourPct: Int, sevenDayPct: Int) -> String {
        if tier.isEmpty && activity.isEmpty { return "" }

        func barColor(_ pct: Int) -> String {
            if pct >= 80 { return "#ef4444" }
            if pct >= 50 { return "#eab308" }
            return "#4ade80"
        }

        var quotaBars = ""
        if quotaAvailable {
            quotaBars = """
            <div class="q-bars">
              <div class="q-bar">
                <span class="q-lbl">5H</span>
                <div class="q-track"><div class="q-fill" style="width:\(fiveHourPct)%;background:\(barColor(fiveHourPct))"></div></div>
                <span class="q-pct">\(fiveHourPct)%</span>
              </div>
              <div class="q-bar">
                <span class="q-lbl">7D</span>
                <div class="q-track"><div class="q-fill" style="width:\(sevenDayPct)%;background:\(barColor(sevenDayPct))"></div></div>
                <span class="q-pct">\(sevenDayPct)%</span>
              </div>
            </div>
            """
        }

        return """
        <div class="quota-sec">
          <span class="q-tier">\(escHTML(tier))</span>
          <span class="q-act">\(escHTML(activity))</span>
          \(quotaBars)
        </div>
        """
    }

    static func escHTML(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;")
         .replacingOccurrences(of: "<", with: "&lt;")
         .replacingOccurrences(of: ">", with: "&gt;")
    }

    static func normalizeStatus(_ status: String?) -> String {
        let normalized = String(status ?? "idle").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if normalized == "active" || normalized == "working" { return "working" }
        if normalized == "waiting" { return "waiting" }
        return normalized == "idle" ? "idle" : "idle"
    }

    static func normalizeTokenUsage(_ usage: [String: Any]?) -> (input: Int, output: Int, cacheRead: Int, cacheCreate: Int) {
        guard let usage = usage else {
            return (input: 0, output: 0, cacheRead: 0, cacheCreate: 0)
        }

        let input = Self.readFirstNumber(
            usage,
            keys: [
                "input",
                "totalInput",
                "total_input",
                "input_tokens",
                "inputTokens",
                "prompt_tokens",
                "promptTokens",
                "total_input_tokens",
            ]
        ) ?? 0.0

        let output = Self.readFirstNumber(
            usage,
            keys: [
                "output",
                "totalOutput",
                "total_output",
                "output_tokens",
                "outputTokens",
                "completion_tokens",
                "completionTokens",
                "total_output_tokens",
            ]
        ) ?? 0.0

        let cacheRead = Self.readFirstNumber(
            usage,
            keys: [
                "cacheRead",
                "cache_read",
                "cached_input_tokens",
                "cache_read_input_tokens",
                "cacheReadInputTokens",
            ]
        ) ?? 0.0

        let cacheCreate = Self.readFirstNumber(
            usage,
            keys: [
                "cacheCreate",
                "cache_create_tokens",
                "cacheCreateTokens",
                "cacheWrite",
                "cache_write",
                "cache_creation_input_tokens",
            ]
        ) ?? 0.0

        return (
            input: Int(max(0, input.rounded())),
            output: Int(max(0, output.rounded())),
            cacheRead: Int(max(0, cacheRead.rounded())),
            cacheCreate: Int(max(0, cacheCreate.rounded())),
        )
    }

    static let claudeRates: [(match: String, input: Double, output: Double, cacheRead: Double, cacheCreate: Double)] = [
        (match: "opus", input: 15, output: 75, cacheRead: 1.5, cacheCreate: 18.75),
        (match: "sonnet", input: 3, output: 15, cacheRead: 0.3, cacheCreate: 3.75),
        (match: "haiku", input: 0.8, output: 4, cacheRead: 0.08, cacheCreate: 1),
    ]

    static let openAIRates: [(match: String, input: Double, output: Double, cacheRead: Double, cacheCreate: Double)] = [
        (match: "gpt-5.5", input: 15, output: 120, cacheRead: 1.5, cacheCreate: 0),
        (match: "gpt-5.4", input: 10, output: 80, cacheRead: 1, cacheCreate: 0),
        (match: "gpt-5.3", input: 5, output: 40, cacheRead: 0.5, cacheCreate: 0),
        (match: "gpt-5", input: 1.25, output: 10, cacheRead: 0.125, cacheCreate: 0),
    ]

    static let defaultClaudeRates = (input: 3.0, output: 15.0, cacheRead: 0.3, cacheCreate: 3.75)
    static let defaultOpenAIRates = (input: 1.25, output: 10.0, cacheRead: 0.125, cacheCreate: 0.0)

    static func pricingForModel(_ model: String?, _ provider: String?) -> (input: Double, output: Double, cacheRead: Double, cacheCreate: Double) {
        let normalizedModel = (model ?? "").lowercased()
        let normalizedProvider = (provider ?? "").lowercased()
        let table = (normalizedProvider == "codex" || normalizedModel.contains("gpt")) ? Self.openAIRates : Self.claudeRates
        if let match = table.first(where: { normalizedModel.contains($0.match) }) {
            return (input: match.input, output: match.output, cacheRead: match.cacheRead, cacheCreate: match.cacheCreate)
        }
        return normalizedProvider == "codex" || normalizedModel.contains("gpt") ? Self.defaultOpenAIRates : Self.defaultClaudeRates
    }

    static func estimateTokenCost(_ usage: [String: Any]?, model: String?, provider: String?) -> Double {
        let normalizedUsage = Self.normalizeTokenUsage(usage)
        let rates = Self.pricingForModel(model, provider)
        let total = Double(normalizedUsage.input) * rates.input
            + Double(normalizedUsage.output) * rates.output
            + Double(normalizedUsage.cacheRead) * rates.cacheRead
            + Double(normalizedUsage.cacheCreate) * rates.cacheCreate
        return max(0, total / 1_000_000)
    }

    static func readFirstNumber(_ usage: [String: Any], keys: [String]) -> Double? {
        for key in keys {
            if let value = usage[key], let parsed = Self.toDouble(value) {
                return parsed
            }
        }
        return nil
    }

    static func toDouble(_ value: Any?) -> Double? {
        if let num = value as? NSNumber { return num.doubleValue }
        if let intValue = value as? Int { return Double(intValue) }
        if let doubleValue = value as? Double { return doubleValue }
        if let floatValue = value as? Float { return Double(floatValue) }
        if let stringValue = value as? String { return Double(stringValue.trimmingCharacters(in: .whitespacesAndNewlines)) }
        return nil
    }

    static func toInt(_ value: Any?) -> Int {
        guard let parsed = Self.toDouble(value), parsed.isFinite else { return 0 }
        return max(0, Int(parsed.rounded()))
    }

    // MARK: - Server Management

    func startServerIfNeeded() -> Bool {
        if isClaudeVilleServerReachable(timeout: 1.0) {
            ownsServer = false
            return true
        }

        guard let projectPath = readProjectPath() else { return false }
        let serverScript = projectPath + "/claudeville/server.js"
        guard FileManager.default.fileExists(atPath: serverScript) else { return false }
        guard let nodePath = readNodePath() ?? findNode() else { return false }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: nodePath)
        proc.arguments = [serverScript]
        proc.currentDirectoryURL = URL(fileURLWithPath: projectPath)
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        do {
            try proc.run()
        } catch {
            return false
        }
        serverProcess = proc
        ownsServer = true
        let ready = waitForServerReady(timeout: 8.0)
        if !ready {
            if proc.isRunning { proc.terminate() }
            serverProcess = nil
            ownsServer = false
        }
        return ready
    }

    func stopServer() {
        if ownsServer, let proc = serverProcess, proc.isRunning {
            proc.terminate()
        }
        serverProcess = nil
        ownsServer = false
    }

    func waitForServerReady(timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if isClaudeVilleServerReachable(timeout: 0.8) { return true }
            Thread.sleep(forTimeInterval: 0.35)
        }
        return false
    }

    func isClaudeVilleServerReachable(timeout: TimeInterval) -> Bool {
        guard let url = URL(string: "\(serverBase)/api/providers") else { return false }
        var request = URLRequest(url: url)
        request.timeoutInterval = timeout

        let semaphore = DispatchSemaphore(value: 0)
        var healthy = false
        URLSession.shared.dataTask(with: request) { data, response, error in
            defer { semaphore.signal() }
            guard error == nil,
                  let http = response as? HTTPURLResponse,
                  http.statusCode == 200,
                  let data = data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                return
            }
            healthy = json["providers"] is [[String: Any]]
                && json["count"] != nil
        }.resume()

        let waitResult = semaphore.wait(timeout: .now() + timeout + 0.5)
        return waitResult == .success && healthy
    }

    func findNode() -> String? {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let fnmBase = "\(home)/.local/share/fnm/node-versions"
        if let versions = try? FileManager.default.contentsOfDirectory(atPath: fnmBase) {
            for v in versions.sorted().reversed() {
                let p = "\(fnmBase)/\(v)/installation/bin/node"
                if FileManager.default.fileExists(atPath: p) { return p }
            }
        }
        for c in ["\(home)/.nvm/current/bin/node", "/opt/homebrew/bin/node", "/usr/local/bin/node"] {
            if FileManager.default.fileExists(atPath: c) { return c }
        }
        return nil
    }

    func readNodePath() -> String? {
        guard let resURL = Bundle.main.resourceURL else { return nil }
        let f = resURL.appendingPathComponent("node_path")
        guard let p = try? String(contentsOf: f, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines) else { return nil }
        return FileManager.default.fileExists(atPath: p) ? p : nil
    }

    func readProjectPath() -> String? {
        guard let resURL = Bundle.main.resourceURL else { return nil }
        let f = resURL.appendingPathComponent("project_path")
        return try? String(contentsOf: f, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: - Status Item

    func setupStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        guard let button = statusItem.button else { return }
        button.title = "● 0"
        button.font = NSFont.systemFont(ofSize: 13)
        button.action = #selector(statusItemClicked(_:))
        button.target = self
        button.sendAction(on: [.leftMouseUp, .rightMouseUp])
    }

    @objc func statusItemClicked(_ sender: NSStatusBarButton) {
        guard let event = NSApp.currentEvent else { return }
        if event.type == .rightMouseUp { showMenu() } else { togglePopover() }
    }

    func togglePopover() {
        guard let button = statusItem.button else { return }
        if popover.isShown {
            popover.performClose(nil)
        } else {
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            popover.contentViewController?.view.window?.makeKey()
        }
    }

    func showMenu() {
        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "Open Dashboard", action: #selector(openDashboard), keyEquivalent: "d"))
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "Quit", action: #selector(quitApp), keyEquivalent: "q"))
        statusItem.menu = menu
        statusItem.button?.performClick(nil)
        statusItem.menu = nil
    }

    @objc func openDashboard() {
        if let window = dashboardWindow, window.isVisible {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        let screen = NSScreen.main ?? NSScreen.screens[0]
        let w: CGFloat = 1200, h: CGFloat = 800
        let window = NSWindow(
            contentRect: NSRect(x: (screen.frame.width-w)/2, y: (screen.frame.height-h)/2, width: w, height: h),
            styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false
        )
        window.title = "ClaudeVille Dashboard"
        window.minSize = NSSize(width: 800, height: 600)
        window.isReleasedWhenClosed = false
        let wv = WKWebView(frame: window.contentView!.bounds)
        wv.autoresizingMask = [.width, .height]
        wv.load(URLRequest(url: URL(string: serverBase)!))
        window.contentView?.addSubview(wv)
        dashboardWebView = wv; dashboardWindow = window
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc func quitApp() { NSApp.terminate(nil) }

    // MARK: - Popover

    func setupPopover() {
        let config = WKWebViewConfiguration()
        let handler = MessageHandler(delegate: self)
        config.userContentController.add(handler, name: "openDashboard")
        config.userContentController.add(handler, name: "badge")

        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 320, height: 420), configuration: config)
        webView.setValue(false, forKey: "drawsBackground")

        let vc = NSViewController()
        vc.view = webView

        popover = NSPopover()
        popover.contentSize = NSSize(width: 320, height: 420)
        popover.behavior = .transient
        popover.contentViewController = vc
        popover.animates = true
    }

    func updateBadge(working: Int) {
        statusItem.button?.title = "● \(working)"
    }
}

// MARK: - WKScriptMessageHandler

class MessageHandler: NSObject, WKScriptMessageHandler {
    weak var delegate: AppDelegate?
    init(delegate: AppDelegate) { self.delegate = delegate }
    func userContentController(_ uc: WKUserContentController, didReceive msg: WKScriptMessage) {
        if msg.name == "openDashboard" {
            delegate?.openDashboard()
            return
        }
        if msg.name == "badge",
           let body = msg.body as? [String: Any],
           let working = AppDelegate.toDouble(body["working"]) {
            delegate?.updateBadge(working: AppDelegate.toInt(working))
        }
    }
}

// MARK: - Entry Point

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
