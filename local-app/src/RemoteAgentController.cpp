#include "RemoteAgentController.h"

#include <QJsonArray>
#include <QJsonDocument>
#include <QNetworkReply>
#include <QNetworkRequest>

RemoteAgentController::RemoteAgentController(quint16 port, QObject *parent) : QObject(parent), m_port(port) {
    m_timer.setInterval(1500);
    connect(&m_timer, &QTimer::timeout, this, &RemoteAgentController::refresh);
    m_timer.start();
    loadConfig();
    refresh();
}

QJsonObject RemoteAgentController::config() const {
    return {{QStringLiteral("cloudUrl"), m_cloudUrl}, {QStringLiteral("providerId"), m_providerId},
            {QStringLiteral("providerToken"), m_providerToken}, {QStringLiteral("localBaseUrl"), m_localBaseUrl},
            {QStringLiteral("localApiKey"), m_localApiKey}, {QStringLiteral("autoConnect"), m_autoConnect}};
}

void RemoteAgentController::call(const QString &method, const QString &path, const QJsonObject &body, const std::function<void(const QJsonObject &, bool)> &callback) {
    QNetworkRequest request(QUrl(QStringLiteral("http://127.0.0.1:%1%2").arg(m_port).arg(path)));
    request.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json"));
    request.setTransferTimeout(2500);
    const QByteArray payload = QJsonDocument(body).toJson(QJsonDocument::Compact);
    QNetworkReply *reply = method == QStringLiteral("GET") ? m_network.get(request) : m_network.sendCustomRequest(request, method.toUtf8(), payload);
    connect(reply, &QNetworkReply::finished, this, [this, reply, callback] {
        const QJsonDocument document = QJsonDocument::fromJson(reply->readAll());
        callback(document.object(), reply->error() == QNetworkReply::NoError && document.isObject());
        reply->deleteLater();
    });
}

void RemoteAgentController::loadConfig() {
    call(QStringLiteral("GET"), QStringLiteral("/api/config"), {}, [this](const QJsonObject &object, bool ok) {
        if (!ok) { emit notice(QStringLiteral("无法连接 utoken 后台服务，请先运行 utoken up"), true); return; }
        m_cloudUrl = object.value(QStringLiteral("cloudUrl")).toString();
        m_providerId = object.value(QStringLiteral("providerId")).toInt();
        m_providerToken = object.value(QStringLiteral("providerToken")).toString();
        m_localBaseUrl = object.value(QStringLiteral("localBaseUrl")).toString();
        m_localApiKey = object.value(QStringLiteral("localApiKey")).toString();
        m_autoConnect = object.value(QStringLiteral("autoConnect")).toBool();
        emit cloudUrlChanged(); emit providerIdChanged(); emit providerTokenChanged();
        emit localBaseUrlChanged(); emit localApiKeyChanged(); emit autoConnectChanged();
    });
}

void RemoteAgentController::refresh() {
    call(QStringLiteral("GET"), QStringLiteral("/api/status"), {}, [this](const QJsonObject &object, bool ok) {
        if (!ok) {
            if (m_connectionState != QStringLiteral("unavailable")) { m_connectionState = QStringLiteral("unavailable"); emit connectionStateChanged(); }
            return;
        }
        const QString state = object.value(QStringLiteral("connectionState")).toString();
        if (m_connectionState != state) { m_connectionState = state; emit connectionStateChanged(); }
        m_providerName = object.value(QStringLiteral("providerName")).toString();
        m_localOnline = object.value(QStringLiteral("localOnline")).toBool();
        m_localLatency = object.value(QStringLiteral("localLatency")).toInt();
        m_activeRequests = object.value(QStringLiteral("activeRequests")).toInt();
        m_totalRequests = object.value(QStringLiteral("totalRequests")).toInt();
        emit statusChanged();
        QStringList logs;
        const QJsonArray entries = object.value(QStringLiteral("logs")).toArray();
        for (const auto &entry : entries) logs.append(entry.toString());
        if (logs != m_logs) { m_logs = logs; emit logsChanged(); }
    });
}

void RemoteAgentController::start() {
    call(QStringLiteral("POST"), QStringLiteral("/api/start"), config(), [this](const QJsonObject &, bool ok) {
        emit notice(ok ? QStringLiteral("配置已保存，正在启动代理") : QStringLiteral("无法启动 utoken 后台代理"), !ok);
        refresh();
    });
}
void RemoteAgentController::stop() {
    call(QStringLiteral("POST"), QStringLiteral("/api/stop"), {}, [this](const QJsonObject &, bool ok) {
        emit notice(ok ? QStringLiteral("本地代理已停止") : QStringLiteral("停止失败"), !ok); refresh();
    });
}
void RemoteAgentController::checkLocalHealth() {
    call(QStringLiteral("POST"), QStringLiteral("/api/check"), {}, [this](const QJsonObject &, bool ok) {
        emit notice(ok ? QStringLiteral("正在探测本地推理服务") : QStringLiteral("探测失败"), !ok);
    });
}
void RemoteAgentController::clearLogs() {
    call(QStringLiteral("POST"), QStringLiteral("/api/clear-logs"), {}, [this](const QJsonObject &, bool) { refresh(); });
}
