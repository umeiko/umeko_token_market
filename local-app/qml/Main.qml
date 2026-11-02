import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

ApplicationWindow {
    id: window
    width: 1100
    height: 740
    minimumWidth: 900
    minimumHeight: 640
    visible: true
    title: "Umeko Token Relay · 本地连接端"
    color: "#f4f8fa"

    property int currentPage: 0
    property color accent: "#087f95"
    property color ink: "#183b47"
    property color muted: "#6a8590"
    property color line: "#dce8ed"
    property string toastText: ""
    property bool toastError: false

    component Card: Rectangle {
        color: "#ffffff"
        radius: 12
        border.color: "#dce8ed"
        border.width: 1
    }

    component FormField: ColumnLayout {
        id: fieldRoot
        property string label: ""
        property string placeholder: ""
        property alias text: input.text
        property bool password: false
        signal edited()
        spacing: 7
        Layout.fillWidth: true
        Text { text: fieldRoot.label; color: "#496a76"; font.pixelSize: 12; font.weight: Font.Medium }
        TextField {
            id: input
            Layout.fillWidth: true
            Layout.preferredHeight: 42
            placeholderText: fieldRoot.placeholder
            echoMode: fieldRoot.password ? TextInput.Password : TextInput.Normal
            color: "#183b47"
            font.pixelSize: 12
            leftPadding: 12
            rightPadding: 12
            background: Rectangle { color: "#ffffff"; radius: 7; border.color: input.activeFocus ? "#70b7c5" : "#d7e5ea"; border.width: 1 }
            onEditingFinished: fieldRoot.edited()
        }
    }

    component StatCard: Card {
        property string title: ""
        property string value: ""
        property string detail: ""
        property string iconText: "●"
        property color iconColor: "#087f95"
        implicitHeight: 112
        Layout.fillWidth: true
        Text { x: 18; y: 17; text: parent.title; color: "#68838e"; font.pixelSize: 12 }
        Rectangle {
            anchors.right: parent.right; anchors.top: parent.top; anchors.margins: 16
            width: 34; height: 34; radius: 9; color: Qt.alpha(parent.iconColor, 0.1)
            Text { anchors.centerIn: parent; text: parent.parent.iconText; color: parent.parent.iconColor; font.pixelSize: 16 }
        }
        Text { x: 18; y: 43; text: parent.value; color: "#183b47"; font.pixelSize: 25; font.weight: Font.DemiBold }
        Text { x: 18; y: 82; text: parent.detail; color: "#8a9da5"; font.pixelSize: 10 }
    }

    component StatusBadge: Rectangle {
        property string text: ""
        property color badgeColor: "#718992"
        implicitWidth: badgeLabel.implicitWidth + 22
        implicitHeight: 25
        radius: 6
        color: Qt.alpha(badgeColor, 0.09)
        border.color: Qt.alpha(badgeColor, 0.18)
        Row {
            anchors.centerIn: parent; spacing: 6
            Rectangle { width: 6; height: 6; radius: 3; color: badgeColor; anchors.verticalCenter: parent.verticalCenter }
            Text { id: badgeLabel; text: parent.parent.text; color: badgeColor; font.pixelSize: 10; font.weight: Font.Medium }
        }
    }

    function cloudStatus() {
        if (agent.connectionState === "online") return "服务已上线"
        if (agent.connectionState === "connecting") return "正在连接云端"
        if (agent.connectionState === "authenticating") return "正在验证凭据"
        if (agent.connectionState === "reconnecting") return "等待自动重连"
        return "代理未连接"
    }
    function cloudColor() {
        if (agent.connectionState === "online") return "#179482"
        if (agent.connectionState === "offline") return "#718992"
        return "#b17b2d"
    }

    Connections {
        target: agent
        function onNotice(message, isError) {
            window.toastText = message
            window.toastError = isError
            toastTimer.restart()
        }
    }
    Timer { id: toastTimer; interval: 3200; onTriggered: window.toastText = "" }

    RowLayout {
        anchors.fill: parent
        spacing: 0

        Rectangle {
            Layout.preferredWidth: 220
            Layout.fillHeight: true
            color: "#f8fbfc"
            border.color: "#dce8ed"
            ColumnLayout {
                anchors.fill: parent
                anchors.margins: 18
                spacing: 6
                RowLayout {
                    Layout.fillWidth: true
                    Layout.bottomMargin: 32
                    spacing: 11
                    Rectangle {
                        width: 38; height: 38; radius: 10; color: window.accent
                        Text { anchors.centerIn: parent; text: "U"; color: "white"; font.pixelSize: 21; font.weight: Font.Bold }
                    }
                    ColumnLayout {
                        spacing: 1
                        Text { text: "UMEKO TOKEN"; color: window.ink; font.pixelSize: 14; font.weight: Font.DemiBold; font.letterSpacing: 0.7 }
                        Text { text: "LOCAL AGENT"; color: "#8199a2"; font.pixelSize: 8; font.letterSpacing: 2 }
                    }
                }
                Text { text: "本地工作台"; color: "#91a4ab"; font.pixelSize: 9; font.letterSpacing: 1.2; Layout.leftMargin: 10; Layout.bottomMargin: 6 }
                Repeater {
                    model: [
                        { title: "连接概览", icon: "▦" },
                        { title: "运行日志", icon: "☷" },
                        { title: "接入说明", icon: "?" }
                    ]
                    delegate: Button {
                        required property var modelData
                        required property int index
                        Layout.fillWidth: true
                        Layout.preferredHeight: 44
                        onClicked: window.currentPage = index
                        background: Rectangle { color: window.currentPage === index ? "#e5f3f6" : (parent.hovered ? "#eef5f7" : "transparent"); radius: 7 }
                        contentItem: RowLayout {
                            spacing: 12
                            Text { text: modelData.icon; color: window.currentPage === index ? window.accent : "#64808b"; font.pixelSize: 18; Layout.leftMargin: 10 }
                            Text { text: modelData.title; color: window.currentPage === index ? window.accent : "#5b7884"; font.pixelSize: 12; font.weight: window.currentPage === index ? Font.DemiBold : Font.Normal }
                        }
                    }
                }
                Item { Layout.fillHeight: true }
                Card {
                    Layout.fillWidth: true
                    implicitHeight: 70
                    color: "#eef7f8"
                    border.color: "#dcecef"
                    RowLayout {
                        anchors.fill: parent; anchors.margins: 13; spacing: 10
                        Rectangle { width: 8; height: 8; radius: 4; color: window.cloudColor() }
                        ColumnLayout {
                            spacing: 3
                            Text { text: agent.connectionState === "online" ? "本地代理运行中" : "本地代理未上线"; color: window.ink; font.pixelSize: 10; font.weight: Font.Medium }
                            Text { text: "Qt / QML Desktop"; color: window.muted; font.pixelSize: 9 }
                        }
                    }
                }
                Text { text: "UMEKO TOKEN  ·  v1.0.0"; color: "#9aabb1"; font.pixelSize: 8; Layout.alignment: Qt.AlignHCenter; Layout.topMargin: 10 }
            }
        }

        ColumnLayout {
            Layout.fillWidth: true
            Layout.fillHeight: true
            spacing: 0

            Rectangle {
                Layout.fillWidth: true
                Layout.preferredHeight: 65
                color: "transparent"
                border.color: window.line
                RowLayout {
                    anchors.fill: parent; anchors.leftMargin: 30; anchors.rightMargin: 30
                    Text { text: "本地连接端  /  " + ["连接概览", "运行日志", "接入说明"][window.currentPage]; color: window.muted; font.pixelSize: 11 }
                    Item { Layout.fillWidth: true }
                    Rectangle { width: 6; height: 6; radius: 3; color: "#20a18e" }
                    Text { text: "桌面应用已就绪"; color: "#5b7b86"; font.pixelSize: 10 }
                }
            }

            StackLayout {
                Layout.fillWidth: true
                Layout.fillHeight: true
                currentIndex: window.currentPage

                Flickable {
                    contentWidth: width
                    contentHeight: overviewContent.implicitHeight + 50
                    clip: true
                    boundsBehavior: Flickable.StopAtBounds
                    ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }
                    ColumnLayout {
                        id: overviewContent
                        x: 30; y: 26; width: parent.width - 60
                        spacing: 18
                        RowLayout {
                            Layout.fillWidth: true
                            ColumnLayout {
                                spacing: 6
                                Text { text: "连接概览"; color: window.ink; font.pixelSize: 24; font.weight: Font.DemiBold }
                                Text { text: "将家中已有的模型服务安全接入云端"; color: window.muted; font.pixelSize: 11 }
                            }
                            Item { Layout.fillWidth: true }
                            StatusBadge { text: window.cloudStatus(); badgeColor: window.cloudColor() }
                        }

                        RowLayout {
                            Layout.fillWidth: true
                            spacing: 14
                            StatCard { title: "云端连接"; value: agent.connectionState === "online" ? "在线" : "未在线"; detail: agent.providerName || "等待供应商凭据验证"; iconText: "↗"; iconColor: "#078c95" }
                            StatCard { title: "本地推理"; value: agent.localOnline ? "正常" : "未就绪"; detail: agent.localLatency >= 0 ? "最近探测延迟 " + agent.localLatency + " ms" : "尚未完成健康探测"; iconText: "⌁"; iconColor: agent.localOnline ? "#3979ac" : "#b17b2d" }
                            StatCard { title: "活动 / 累计请求"; value: agent.activeRequests + " / " + agent.totalRequests; detail: "流式请求会计入活动并发"; iconText: "▥"; iconColor: "#7966a7" }
                        }

                        GridLayout {
                            Layout.fillWidth: true
                            columns: 2
                            columnSpacing: 18
                            rowSpacing: 18

                            Card {
                                Layout.fillWidth: true
                                Layout.preferredWidth: 1.25
                                implicitHeight: settingsColumn.implicitHeight + 36
                                ColumnLayout {
                                    id: settingsColumn
                                    anchors.left: parent.left; anchors.right: parent.right; anchors.top: parent.top; anchors.margins: 18
                                    spacing: 14
                                    ColumnLayout {
                                        spacing: 4
                                        Text { text: "连接配置"; color: window.ink; font.pixelSize: 15; font.weight: Font.DemiBold }
                                        Text { text: "凭据仅用于连接你的云端服务"; color: window.muted; font.pixelSize: 10 }
                                    }
                                    FormField { label: "云端服务地址"; placeholder: "https://api.example.com"; text: agent.cloudUrl; onEdited: agent.cloudUrl = text }
                                    RowLayout {
                                        Layout.fillWidth: true; spacing: 12
                                        ColumnLayout {
                                            Layout.preferredWidth: 110; spacing: 7
                                            Text { text: "供应商 ID"; color: "#496a76"; font.pixelSize: 12; font.weight: Font.Medium }
                                            SpinBox {
                                                Layout.fillWidth: true; Layout.preferredHeight: 42; from: 1; to: 999999; value: agent.providerId; editable: true
                                                onValueModified: agent.providerId = value
                                            }
                                        }
                                        FormField { label: "供应商连接凭据"; placeholder: "umo-agent-..."; text: agent.providerToken; password: true; onEdited: agent.providerToken = text }
                                    }
                                    FormField { label: "本地推理服务地址"; placeholder: "http://127.0.0.1:8080"; text: agent.localBaseUrl; onEdited: agent.localBaseUrl = text }
                                    FormField { label: "本地 API Key（可选）"; placeholder: "llama.cpp / vLLM 通常无需填写"; text: agent.localApiKey; password: true; onEdited: agent.localApiKey = text }
                                    RowLayout {
                                        Layout.fillWidth: true
                                        Text { text: "启动应用后自动连接"; color: "#587681"; font.pixelSize: 11 }
                                        Item { Layout.fillWidth: true }
                                        Switch { checked: agent.autoConnect; onToggled: agent.autoConnect = checked }
                                    }
                                    RowLayout {
                                        Layout.fillWidth: true; spacing: 9
                                        Button {
                                            Layout.fillWidth: true; Layout.preferredHeight: 41
                                            enabled: agent.connectionState === "offline" || agent.connectionState === "reconnecting"
                                            onClicked: agent.start()
                                            background: Rectangle { radius: 7; color: parent.enabled ? (parent.hovered ? "#076e82" : window.accent) : "#bfd0d6" }
                                            contentItem: Text { text: "保存并启动代理"; color: "white"; font.pixelSize: 12; font.weight: Font.Medium; horizontalAlignment: Text.AlignHCenter; verticalAlignment: Text.AlignVCenter }
                                        }
                                        Button {
                                            Layout.preferredHeight: 41; enabled: agent.connectionState !== "offline"; onClicked: agent.stop()
                                            background: Rectangle { radius: 7; color: parent.hovered ? "#f1f6f8" : "#ffffff"; border.color: "#d7e5ea" }
                                            contentItem: Text { text: "停止"; color: "#587681"; font.pixelSize: 12; horizontalAlignment: Text.AlignHCenter }
                                        }
                                        Button {
                                            Layout.preferredHeight: 41; onClicked: { agent.checkLocalHealth(); window.toastError = false; window.toastText = "正在探测本地推理服务"; toastTimer.restart() }
                                            background: Rectangle { radius: 7; color: parent.hovered ? "#f1f6f8" : "#ffffff"; border.color: "#d7e5ea" }
                                            contentItem: Text { text: "探测本地"; color: window.accent; font.pixelSize: 12; horizontalAlignment: Text.AlignHCenter }
                                        }
                                    }
                                }
                            }

                            Card {
                                Layout.fillWidth: true
                                Layout.preferredWidth: 0.75
                                Layout.fillHeight: true
                                ColumnLayout {
                                    anchors.fill: parent; anchors.margins: 20; spacing: 16
                                    Text { text: "运行状态"; color: window.ink; font.pixelSize: 15; font.weight: Font.DemiBold }
                                    Rectangle {
                                        Layout.alignment: Qt.AlignHCenter; Layout.topMargin: 8
                                        width: 92; height: 92; radius: 46; color: Qt.alpha(window.cloudColor(), 0.08); border.color: Qt.alpha(window.cloudColor(), 0.18)
                                        Rectangle { anchors.centerIn: parent; width: 68; height: 68; radius: 34; color: Qt.alpha(window.cloudColor(), 0.12)
                                            Text { anchors.centerIn: parent; text: agent.connectionState === "online" ? "✓" : "↗"; color: window.cloudColor(); font.pixelSize: 29 }
                                        }
                                    }
                                    Text { Layout.alignment: Qt.AlignHCenter; text: window.cloudStatus(); color: window.ink; font.pixelSize: 16; font.weight: Font.DemiBold }
                                    Text { Layout.alignment: Qt.AlignHCenter; Layout.fillWidth: true; text: agent.connectionState === "online" ? "云端请求将转发至本地推理端口" : "填写配置并启动代理以接收请求"; color: window.muted; font.pixelSize: 10; horizontalAlignment: Text.AlignHCenter; wrapMode: Text.Wrap }
                                    Rectangle { Layout.fillWidth: true; height: 1; color: "#e8f0f3" }
                                    Repeater {
                                        model: [
                                            { name: "云端节点", value: agent.providerName || "未验证" },
                                            { name: "本地服务", value: agent.localOnline ? "可用" : "不可用 / 未探测" },
                                            { name: "活动请求", value: agent.activeRequests + " 个" },
                                            { name: "健康延迟", value: agent.localLatency >= 0 ? agent.localLatency + " ms" : "—" }
                                        ]
                                        delegate: RowLayout {
                                            required property var modelData
                                            Layout.fillWidth: true
                                            Text { text: modelData.name; color: window.muted; font.pixelSize: 10 }
                                            Item { Layout.fillWidth: true }
                                            Text { text: modelData.value; color: window.ink; font.pixelSize: 10; font.weight: Font.Medium; elide: Text.ElideRight }
                                        }
                                    }
                                    Item { Layout.fillHeight: true }
                                    Rectangle {
                                        Layout.fillWidth: true; implicitHeight: securityText.implicitHeight + 22; radius: 7; color: "#eff7f8"
                                        Text { id: securityText; anchors.fill: parent; anchors.margins: 11; text: "本地推理端口无需暴露到公网，所有云端连接均由本应用主动发起。"; color: "#5e7d88"; font.pixelSize: 9; wrapMode: Text.Wrap; lineHeight: 1.4 }
                                    }
                                }
                            }
                        }
                    }
                }

                Card {
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    Layout.margins: 30
                    ColumnLayout {
                        anchors.fill: parent; anchors.margins: 20; spacing: 14
                        RowLayout {
                            Layout.fillWidth: true
                            ColumnLayout {
                                spacing: 5
                                Text { text: "运行日志"; color: window.ink; font.pixelSize: 20; font.weight: Font.DemiBold }
                                Text { text: "显示最近 200 条连接与转发事件，不记录请求内容"; color: window.muted; font.pixelSize: 10 }
                            }
                            Item { Layout.fillWidth: true }
                            StatusBadge { text: agent.logs.length + " 条记录"; badgeColor: "#718992" }
                            Button { text: "清空日志"; onClicked: agent.clearLogs() }
                        }
                        Rectangle { Layout.fillWidth: true; height: 1; color: window.line }
                        ListView {
                            id: logList
                            Layout.fillWidth: true; Layout.fillHeight: true; clip: true
                            model: agent.logs
                            spacing: 2
                            onCountChanged: positionViewAtEnd()
                            delegate: Rectangle {
                                required property string modelData
                                width: logList.width; height: 32; radius: 4; color: index % 2 ? "#fafcfd" : "transparent"
                                Text { anchors.verticalCenter: parent.verticalCenter; anchors.left: parent.left; anchors.right: parent.right; anchors.margins: 9; text: modelData; color: "#53727e"; font.family: "monospace"; font.pixelSize: 11; elide: Text.ElideRight }
                            }
                            ScrollBar.vertical: ScrollBar {}
                            Text { anchors.centerIn: parent; visible: agent.logs.length === 0; text: "暂无日志\n启动本地代理后，连接事件会显示在这里"; color: "#91a4ab"; font.pixelSize: 11; horizontalAlignment: Text.AlignHCenter; lineHeight: 1.6 }
                        }
                    }
                }

                Flickable {
                    contentWidth: width; contentHeight: guideColumn.implicitHeight + 50; clip: true
                    ColumnLayout {
                        id: guideColumn
                        x: 30; y: 28; width: parent.width - 60; spacing: 18
                        ColumnLayout {
                            spacing: 6
                            Text { text: "接入说明"; color: window.ink; font.pixelSize: 24; font.weight: Font.DemiBold }
                            Text { text: "本地应用只负责转发，不会启动或管理推理进程"; color: window.muted; font.pixelSize: 11 }
                        }
                        Repeater {
                            model: [
                                { number: "01", title: "启动你的推理服务", text: "先使用 llama.cpp、vLLM 或 SGLang 启动 OpenAI 兼容服务，确认本机 /v1/models 可以访问。默认地址为 http://127.0.0.1:8080。" },
                                { number: "02", title: "在云端创建供应商", text: "登录云端管理面板，在“供应商与模型”中创建节点，设置模型名称、输入/输出价格和最大并发。连接凭据只显示一次。" },
                                { number: "03", title: "启动本地代理", text: "将云端地址、供应商 ID 和连接凭据填入“连接概览”，保存并启动。两种状态均正常后，即可使用云端生成的 API Key 调用模型。" }
                            ]
                            delegate: Card {
                                required property var modelData
                                Layout.fillWidth: true; implicitHeight: 104
                                RowLayout {
                                    anchors.fill: parent; anchors.margins: 20; spacing: 17
                                    Rectangle { width: 43; height: 43; radius: 11; color: "#e8f5f7"; Text { anchors.centerIn: parent; text: modelData.number; color: window.accent; font.pixelSize: 13; font.weight: Font.DemiBold } }
                                    ColumnLayout {
                                        Layout.fillWidth: true; spacing: 7
                                        Text { text: modelData.title; color: window.ink; font.pixelSize: 14; font.weight: Font.DemiBold }
                                        Text { text: modelData.text; color: window.muted; font.pixelSize: 11; wrapMode: Text.Wrap; Layout.fillWidth: true; lineHeight: 1.45 }
                                    }
                                }
                            }
                        }
                        Card {
                            Layout.fillWidth: true; implicitHeight: 124
                            ColumnLayout {
                                anchors.fill: parent; anchors.margins: 20; spacing: 8
                                Text { text: "配置与安全"; color: window.ink; font.pixelSize: 14; font.weight: Font.DemiBold }
                                Text { text: "配置由 QSettings 保存在当前用户目录。生产环境请使用 HTTPS/WSS，并避免将供应商连接凭据提供给 API 调用方。客户端只应获得云端单独生成的 umo-sk Key。"; color: window.muted; font.pixelSize: 10; wrapMode: Text.Wrap; Layout.fillWidth: true; lineHeight: 1.5 }
                                Text { text: "原 Node.js 命令行代理仍保留在 agent/index.js，可用于无桌面的服务器环境。"; color: "#6c8b96"; font.pixelSize: 9; wrapMode: Text.Wrap; Layout.fillWidth: true }
                            }
                        }
                    }
                }
            }
        }
    }

    Rectangle {
        visible: window.toastText.length > 0
        anchors.right: parent.right; anchors.bottom: parent.bottom; anchors.margins: 24
        width: Math.min(390, toastLabel.implicitWidth + 36); height: toastLabel.implicitHeight + 26
        radius: 9; color: "#ffffff"; border.color: window.toastError ? "#edcbd2" : "#c9e4dd"
        Text { id: toastLabel; anchors.fill: parent; anchors.margins: 13; text: window.toastText; color: window.toastError ? "#b73e50" : "#1b796b"; font.pixelSize: 11; wrapMode: Text.Wrap }
    }
}
