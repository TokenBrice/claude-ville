import QtQuick
import QtQuick.Controls as Controls
import QtQuick.Layouts
import org.kde.kirigami as Kirigami
import org.kde.plasma.components as PlasmaComponents
import org.kde.plasma.core as PlasmaCore
import org.kde.plasma.plasmoid

PlasmoidItem {
    id: root

    readonly property string serverUrl: normalizeUrl(plasmoid.configuration.serverUrl || "http://localhost:4000")
    readonly property int refreshInterval: Math.max(1000, Number(plasmoid.configuration.refreshIntervalMs || 5000))
    readonly property int compactSpriteHeight: Math.max(30, PlasmaCore.Units.gridUnit * 2)
    property var sessionRows: []
    property var workingRows: []
    property var usage: null
    property bool online: false
    property bool loading: false
    property string errorText: ""
    property int workingCount: 0
    property int waitingCount: 0
    property int idleCount: 0
    property int totalTokens: 0
    property real totalCost: 0
    property string activityText: ""

    toolTipMainText: "ClaudeVille"
    toolTipSubText: online
        ? i18n("%1 working, %2 total", workingCount, sessionRows.length)
        : errorText || i18n("Offline")

    Layout.minimumWidth: PlasmaCore.Units.gridUnit * 18
    Layout.minimumHeight: PlasmaCore.Units.gridUnit * 14
    Layout.preferredWidth: PlasmaCore.Units.gridUnit * 24
    Layout.preferredHeight: PlasmaCore.Units.gridUnit * 28

    Timer {
        id: refreshTimer
        interval: root.refreshInterval
        running: true
        repeat: true
        triggeredOnStart: true
        onTriggered: root.refresh()
    }

    compactRepresentation: MouseArea {
        id: compact
        Layout.minimumWidth: Math.max(
            PlasmaCore.Units.iconSizes.smallMedium,
            (spriteStrip.visible ? spriteStrip.implicitWidth : compactFallback.implicitWidth) + PlasmaCore.Units.smallSpacing * 2
        )
        Layout.minimumHeight: Math.max(PlasmaCore.Units.iconSizes.smallMedium, root.compactSpriteHeight)
        onClicked: plasmoid.expanded = !plasmoid.expanded

        Row {
            id: spriteStrip
            visible: root.online && root.workingRows.length > 0
            anchors.centerIn: parent
            spacing: -Math.max(1, Math.round(PlasmaCore.Units.smallSpacing / 2))

            Repeater {
                model: root.workingRows

                delegate: Item {
                    width: modelData.spritePanelWidth
                    height: root.compactSpriteHeight

                    Rectangle {
                        anchors.horizontalCenter: parent.horizontalCenter
                        anchors.bottom: parent.bottom
                        anchors.bottomMargin: 1
                        width: Math.max(12, parent.width - 4)
                        height: 4
                        radius: 2
                        color: Qt.rgba(0, 0, 0, 0.28)
                    }

                    Image {
                        anchors.horizontalCenter: parent.horizontalCenter
                        anchors.bottom: parent.bottom
                        width: modelData.spritePanelWidth
                        height: root.compactSpriteHeight
                        source: modelData.spriteSource
                        sourceClipRect: Qt.rect(
                            modelData.spriteClipX,
                            modelData.spriteClipY,
                            modelData.spriteClipWidth,
                            modelData.spriteClipHeight
                        )
                        fillMode: Image.PreserveAspectFit
                        smooth: false
                        mipmap: false
                        asynchronous: true
                    }
                }
            }
        }

        RowLayout {
            id: compactFallback
            visible: !spriteStrip.visible
            anchors.centerIn: parent
            spacing: PlasmaCore.Units.smallSpacing

            Rectangle {
                Layout.preferredWidth: PlasmaCore.Units.smallSpacing
                Layout.preferredHeight: PlasmaCore.Units.smallSpacing
                radius: width / 2
                color: root.online
                    ? (root.workingCount > 0 ? "#4ade80" : "#60a5fa")
                    : "#f87171"
            }

            PlasmaComponents.Label {
                text: root.online ? i18n("idle") : i18n("off")
                font.bold: true
                elide: Text.ElideRight
            }
        }
    }

    fullRepresentation: Item {
        Layout.minimumWidth: PlasmaCore.Units.gridUnit * 20
        Layout.minimumHeight: PlasmaCore.Units.gridUnit * 20
        Layout.preferredWidth: PlasmaCore.Units.gridUnit * 26
        Layout.preferredHeight: PlasmaCore.Units.gridUnit * 30

        ColumnLayout {
            anchors.fill: parent
            anchors.margins: PlasmaCore.Units.gridUnit
            spacing: PlasmaCore.Units.smallSpacing

            RowLayout {
                Layout.fillWidth: true
                spacing: PlasmaCore.Units.smallSpacing

                Rectangle {
                    Layout.preferredWidth: PlasmaCore.Units.iconSizes.small
                    Layout.preferredHeight: PlasmaCore.Units.iconSizes.small
                    radius: width / 2
                    color: root.online
                        ? (root.workingCount > 0 ? "#4ade80" : "#60a5fa")
                        : "#f87171"
                }

                ColumnLayout {
                    Layout.fillWidth: true
                    spacing: 0

                    PlasmaComponents.Label {
                        Layout.fillWidth: true
                        text: "ClaudeVille"
                        font.bold: true
                        elide: Text.ElideRight
                    }

                    PlasmaComponents.Label {
                        Layout.fillWidth: true
                        text: root.online ? root.activityText : root.errorText || i18n("Waiting for localhost:4000")
                        opacity: 0.72
                        elide: Text.ElideRight
                    }
                }

                PlasmaComponents.ToolButton {
                    icon.name: "view-refresh-symbolic"
                    text: i18n("Refresh")
                    display: Controls.AbstractButton.IconOnly
                    enabled: !root.loading
                    onClicked: root.refresh()
                }

                PlasmaComponents.ToolButton {
                    icon.name: "internet-web-browser-symbolic"
                    text: i18n("Open Dashboard")
                    display: Controls.AbstractButton.IconOnly
                    onClicked: Qt.openUrlExternally(root.serverUrl)
                }
            }

            RowLayout {
                Layout.fillWidth: true
                spacing: PlasmaCore.Units.smallSpacing

                StatPill {
                    Layout.fillWidth: true
                    label: i18n("Working")
                    value: String(root.workingCount)
                    accent: "#4ade80"
                }
                StatPill {
                    Layout.fillWidth: true
                    label: i18n("Waiting")
                    value: String(root.waitingCount)
                    accent: "#facc15"
                }
                StatPill {
                    Layout.fillWidth: true
                    label: i18n("Idle")
                    value: String(root.idleCount)
                    accent: "#60a5fa"
                }
            }

            RowLayout {
                Layout.fillWidth: true
                spacing: PlasmaCore.Units.smallSpacing

                StatPill {
                    Layout.fillWidth: true
                    label: i18n("Tokens")
                    value: root.compactNumber(root.totalTokens)
                    accent: "#c4b5fd"
                }
                StatPill {
                    Layout.fillWidth: true
                    label: i18n("Cost")
                    value: "$" + root.totalCost.toFixed(2)
                    accent: "#fbbf24"
                }
            }

            PlasmaComponents.Label {
                Layout.fillWidth: true
                visible: !root.online
                text: root.errorText || i18n("Start ClaudeVille with npm run dev.")
                wrapMode: Text.WordWrap
                opacity: 0.8
            }

            ListView {
                id: sessionList
                Layout.fillWidth: true
                Layout.fillHeight: true
                clip: true
                spacing: PlasmaCore.Units.smallSpacing
                model: root.sessionRows

                delegate: Rectangle {
                    width: sessionList.width
                    height: PlasmaCore.Units.gridUnit * 3
                    radius: PlasmaCore.Units.smallSpacing
                    color: index % 2 === 0
                        ? Qt.rgba(PlasmaCore.Theme.textColor.r, PlasmaCore.Theme.textColor.g, PlasmaCore.Theme.textColor.b, 0.07)
                        : Qt.rgba(PlasmaCore.Theme.textColor.r, PlasmaCore.Theme.textColor.g, PlasmaCore.Theme.textColor.b, 0.03)

                    RowLayout {
                        anchors.fill: parent
                        anchors.margins: PlasmaCore.Units.smallSpacing
                        spacing: PlasmaCore.Units.smallSpacing

                        Rectangle {
                            Layout.preferredWidth: PlasmaCore.Units.smallSpacing
                            Layout.preferredHeight: PlasmaCore.Units.smallSpacing
                            radius: width / 2
                            color: root.statusColor(modelData.status)
                        }

                        ColumnLayout {
                            Layout.fillWidth: true
                            spacing: 0

                            PlasmaComponents.Label {
                                Layout.fillWidth: true
                                text: modelData.name
                                font.bold: true
                                elide: Text.ElideRight
                            }

                            PlasmaComponents.Label {
                                Layout.fillWidth: true
                                text: modelData.model + "  " + modelData.project
                                opacity: 0.68
                                elide: Text.ElideRight
                            }
                        }

                        PlasmaComponents.Label {
                            text: modelData.statusLabel
                            color: root.statusColor(modelData.status)
                            font.bold: modelData.status === "working"
                        }
                    }
                }
            }
        }
    }

    component StatPill: Rectangle {
        property string label: ""
        property string value: ""
        property color accent: PlasmaCore.Theme.highlightColor

        implicitHeight: PlasmaCore.Units.gridUnit * 2.4
        radius: PlasmaCore.Units.smallSpacing
        color: Qt.rgba(accent.r, accent.g, accent.b, 0.14)
        border.color: Qt.rgba(accent.r, accent.g, accent.b, 0.42)
        border.width: 1

        ColumnLayout {
            anchors.fill: parent
            anchors.margins: PlasmaCore.Units.smallSpacing
            spacing: 0

            PlasmaComponents.Label {
                Layout.fillWidth: true
                text: parent.parent.label
                opacity: 0.7
                elide: Text.ElideRight
            }

            PlasmaComponents.Label {
                Layout.fillWidth: true
                text: parent.parent.value
                font.bold: true
                elide: Text.ElideRight
            }
        }
    }

    function normalizeUrl(value) {
        var url = String(value || "http://localhost:4000").trim()
        while (url.length > 1 && url.endsWith("/")) {
            url = url.slice(0, -1)
        }
        return url || "http://localhost:4000"
    }

    function normalizeStatus(value) {
        var status = String(value || "idle").trim().toLowerCase()
        if (status === "active" || status === "working") return "working"
        if (status === "waiting") return "waiting"
        return "idle"
    }

    function statusLabel(status) {
        if (status === "working") return i18n("Working")
        if (status === "waiting") return i18n("Waiting")
        return i18n("Idle")
    }

    function statusColor(status) {
        if (status === "working") return "#4ade80"
        if (status === "waiting") return "#facc15"
        return "#60a5fa"
    }

    function compactNumber(value) {
        var n = Number(value || 0)
        if (n >= 1000000) return (n / 1000000).toFixed(1) + "M"
        if (n >= 1000) return (n / 1000).toFixed(1) + "K"
        return String(Math.round(n))
    }

    function shortModel(model, effort) {
        var text = String(model || "?")
        if (text.indexOf("gpt-5.5") !== -1) text = "5.5"
        else if (text.indexOf("gpt-5.4") !== -1) text = "5.4"
        else if (text.indexOf("gpt-5.3") !== -1) text = "5.3"
        else if (text.toLowerCase().indexOf("claude") !== -1) text = text.replace(/^claude[-_ ]?/i, "Claude ")
        var effortText = String(effort || "").toLowerCase()
        return effortText ? text + " " + effortText : text
    }

    function normalizedIdentityText(value) {
        return String(value || "")
            .toLowerCase()
            .replace(/[._]/g, "-")
            .replace(/\s+/g, "-")
    }

    function spriteIdFor(model, provider) {
        var normalizedModel = normalizedIdentityText(model)
        var normalizedProvider = normalizedIdentityText(provider)
        if (normalizedModel.indexOf("opus") !== -1) return "agent.claude.opus"
        if (normalizedModel.indexOf("haiku") !== -1) return "agent.claude.haiku"
        if (normalizedModel.indexOf("sonnet") !== -1 || normalizedProvider.indexOf("claude") !== -1) {
            return "agent.claude.sonnet"
        }
        if (normalizedModel.indexOf("gpt-5-3-codex-spark") !== -1) return "agent.codex.gpt53spark"
        if (normalizedModel.indexOf("gpt-5-5") !== -1) return "agent.codex.gpt55"
        if (normalizedModel.indexOf("gpt-5-4") !== -1) return "agent.codex.gpt54"
        if (normalizedProvider.indexOf("gemini") !== -1 || normalizedModel.indexOf("gemini") !== -1) {
            return "agent.gemini.base"
        }
        if (normalizedProvider.indexOf("codex") !== -1
                || normalizedModel.indexOf("codex") !== -1
                || normalizedModel.indexOf("gpt") !== -1) {
            return "agent.codex.gpt54"
        }
        return "agent.codex.gpt54"
    }

    function spriteFrame(spriteId) {
        var frames = {
            "agent.claude.base": [19, 559, 63, 83],
            "agent.claude.haiku": [29, 558, 35, 78],
            "agent.claude.opus": [26, 562, 46, 67],
            "agent.claude.sonnet": [29, 564, 39, 63],
            "agent.codex.base": [19, 568, 63, 74],
            "agent.codex.gpt53spark": [31, 571, 30, 56],
            "agent.codex.gpt54": [30, 571, 35, 54],
            "agent.codex.gpt55": [24, 552, 44, 92],
            "agent.gemini.base": [19, 564, 64, 78]
        }
        var frame = frames[spriteId] || frames["agent.codex.gpt54"]
        return {
            x: frame[0],
            y: frame[1],
            width: frame[2],
            height: frame[3]
        }
    }

    function spriteSource(spriteId) {
        return root.serverUrl + "/assets/sprites/characters/" + spriteId + "/sheet.png"
    }

    function spritePanelWidth(frame) {
        var ratio = Number(frame.width || 1) / Math.max(1, Number(frame.height || 1))
        return Math.max(18, Math.round(root.compactSpriteHeight * ratio))
    }

    function projectName(path) {
        var text = String(path || "")
        if (!text) return i18n("No project")
        var parts = text.split("/")
        return parts[parts.length - 1] || text
    }

    function sessionName(session, index) {
        if (session.name) return String(session.name)
        if (session.agentName) return String(session.agentName)
        if (session.sessionId) return String(session.sessionId).slice(0, 12)
        return i18n("Session %1", index + 1)
    }

    function tokenTotal(session) {
        var usage = session.tokenUsage || session.tokens || session.usage || {}
        return Number(usage.totalInput || usage.input || 0)
            + Number(usage.totalOutput || usage.output || 0)
            + Number(usage.cacheRead || 0)
            + Number(usage.cacheCreate || 0)
    }

    function estimateCost(session) {
        var explicit = Number(session.estimatedCost)
        if (isFinite(explicit) && explicit >= 0) return explicit
        var tokens = tokenTotal(session)
        return tokens * 0.000003
    }

    function sortRows(left, right) {
        var order = { working: 0, waiting: 1, idle: 2 }
        var delta = (order[left.status] || 9) - (order[right.status] || 9)
        if (delta !== 0) return delta
        return String(left.name).localeCompare(String(right.name))
    }

    function requestJson(path, callback) {
        var xhr = new XMLHttpRequest()
        xhr.open("GET", root.serverUrl + path)
        xhr.timeout = 4000
        xhr.onreadystatechange = function() {
            if (xhr.readyState !== 4) return
            if (xhr.status >= 200 && xhr.status < 300) {
                try {
                    callback(null, JSON.parse(xhr.responseText))
                } catch (err) {
                    callback(i18n("Invalid JSON from %1", path), null)
                }
            } else {
                callback(i18n("HTTP %1 from %2", xhr.status, path), null)
            }
        }
        xhr.onerror = function() { callback(i18n("Unable to reach %1", root.serverUrl), null) }
        xhr.ontimeout = function() { callback(i18n("Timed out reaching %1", root.serverUrl), null) }
        xhr.send()
    }

    function refresh() {
        if (root.loading) return
        root.loading = true
        var pending = 2
        var nextSessions = null
        var nextUsage = null
        var failure = ""

        function done(err) {
            if (err && !failure) failure = String(err)
            pending -= 1
            if (pending > 0) return
            root.loading = false
            if (failure) {
                root.online = false
                root.workingRows = []
                root.errorText = failure
                return
            }
            applyData(nextSessions || [], nextUsage || null)
        }

        requestJson("/api/sessions", function(err, data) {
            nextSessions = data && data.sessions ? data.sessions : []
            done(err)
        })
        requestJson("/api/usage", function(err, data) {
            nextUsage = data || null
            done(err)
        })
    }

    function applyData(sessions, usageData) {
        var rows = []
        var working = 0
        var waiting = 0
        var idle = 0
        var tokens = 0
        var cost = 0
        for (var i = 0; i < sessions.length; i++) {
            var session = sessions[i] || {}
            var status = normalizeStatus(session.status)
            if (status === "working") working += 1
            else if (status === "waiting") waiting += 1
            else idle += 1
            var sessionTokens = tokenTotal(session)
            tokens += sessionTokens
            cost += estimateCost(session)
            var spriteId = spriteIdFor(session.model, session.provider)
            var frame = spriteFrame(spriteId)
            rows.push({
                name: sessionName(session, i),
                model: shortModel(session.model, session.reasoningEffort || session.effort),
                project: projectName(session.project),
                status: status,
                statusLabel: statusLabel(status),
                tokens: sessionTokens,
                spriteId: spriteId,
                spriteSource: spriteSource(spriteId),
                spriteClipX: frame.x,
                spriteClipY: frame.y,
                spriteClipWidth: frame.width,
                spriteClipHeight: frame.height,
                spritePanelWidth: spritePanelWidth(frame)
            })
        }
        rows.sort(sortRows)
        var workingRows = []
        for (var j = 0; j < rows.length; j++) {
            if (rows[j].status === "working") workingRows.push(rows[j])
        }
        root.sessionRows = rows
        root.workingRows = workingRows
        root.usage = usageData
        root.workingCount = working
        root.waitingCount = waiting
        root.idleCount = idle
        root.totalTokens = tokens
        root.totalCost = cost
        root.online = true
        root.errorText = ""

        var today = usageData && usageData.activity && usageData.activity.today ? usageData.activity.today : null
        root.activityText = today
            ? i18n("%1 sessions today, %2 messages", Number(today.sessions || 0), Number(today.messages || 0))
            : i18n("%1 sessions", rows.length)
    }

    Component.onCompleted: refresh()
}
