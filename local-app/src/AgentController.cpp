#include "AgentController.h"

#include <QDateTime>
#include <QJsonDocument>
#include <QJsonObject>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QUrl>

AgentController::AgentController(QObject *parent)
    : QObject(parent), m_settings(QStringLiteral("Umeko"), QStringLiteral("utoken")) {
    m_cloudUrl = m_settings.value(QStringLiteral("cloudUrl"), QStringLiteral("http://127.0.0.1:3000")).toString();
    m_providerId = m_settings.value(QStringLiteral("providerId"), 1).toInt();
    m_providerToken = m_settings.value(QStringLiteral("providerToken")).toString();
    m_localBaseUrl = m_settings.value(QStringLiteral("localBaseUrl"), QStringLiteral("http://127.0.0.1:8080")).toString();
    m_localApiKey = m_settings.value(QStringLiteral("localApiKey")).toString();
    m_autoConnect = m_settings.value(QStringLiteral("autoConnect"), false).toBool();

    m_reconnectTimer.setSingleShot(true);
    m_healthTimer.setInterval(15000);
    connect(&m_reconnectTimer, &QTimer::timeout, this, &AgentController::start);
    connect(&m_healthTimer, &QTimer::timeout, this, &AgentController::checkLocalHealth);
    connect(&m_transport, &WebSocketTransport::connected, this, [this] {
        setConnectionState(QStringLiteral("authenticating"));
        addLog(QStringLiteral("云端通道已建立，正在验证供应商凭据"));
        sendJson({{QStringLiteral("type"), QStringLiteral("auth")},
                  {QStringLiteral("providerId"), m_providerId},
                  {QStringLiteral("token"), m_providerToken}});
    });
    connect(&m_transport, &WebSocketTransport::textMessageReceived, this, &AgentController::onCloudMessage);
    connect(&m_transport, &WebSocketTransport::errorOccurred, this, [this](const QString &message) {
        addLog(QStringLiteral("网络错误：%1").arg(message));
    });
    connect(&m_transport, &WebSocketTransport::disconnected, this, [this](const QString &reason) {
        m_healthTimer.stop();
        abortRequests();
        m_providerName.clear();
        emit providerNameChanged();
        if (m_manualStop) {
            setConnectionState(QStringLiteral("offline"));
            return;
        }
        setConnectionState(QStringLiteral("reconnecting"));
        addLog(QStringLiteral("云端连接已断开（%1），%2 秒后重连").arg(reason).arg(m_reconnectDelay / 1000));
        m_reconnectTimer.start(m_reconnectDelay);
        m_reconnectDelay = qMin(30000, m_reconnectDelay * 2);
    });
}

void AgentController::setCloudUrl(const QString &value) {
    if (m_cloudUrl == value) return;
    m_cloudUrl = value;
    emit cloudUrlChanged();
}
void AgentController::setProviderId(int value) {
    if (m_providerId == value) return;
    m_providerId = value;
    emit providerIdChanged();
}
void AgentController::setProviderToken(const QString &value) {
    if (m_providerToken == value) return;
    m_providerToken = value;
    emit providerTokenChanged();
}
void AgentController::setLocalBaseUrl(const QString &value) {
    if (m_localBaseUrl == value) return;
    m_localBaseUrl = value;
    emit localBaseUrlChanged();
}
void AgentController::setLocalApiKey(const QString &value) {
    if (m_localApiKey == value) return;
    m_localApiKey = value;
    emit localApiKeyChanged();
}
void AgentController::setAutoConnect(bool value) {
    if (m_autoConnect == value) return;
    m_autoConnect = value;
    m_settings.setValue(QStringLiteral("autoConnect"), value);
    emit autoConnectChanged();
}

QUrl AgentController::endpoint() const {
    QUrl url(m_cloudUrl.trimmed());
    if (url.scheme() == QStringLiteral("http")) url.setScheme(QStringLiteral("ws"));
    else if (url.scheme() == QStringLiteral("https")) url.setScheme(QStringLiteral("wss"));
    QString path = url.path();
    if (path.endsWith(QLatin1Char('/'))) path.chop(1);
    url.setPath(path + QStringLiteral("/agent/connect"));
    return url;
}

void AgentController::saveSettings() {
    m_settings.setValue(QStringLiteral("cloudUrl"), m_cloudUrl.trimmed());
    m_settings.setValue(QStringLiteral("providerId"), m_providerId);
    m_settings.setValue(QStringLiteral("providerToken"), m_providerToken);
    m_settings.setValue(QStringLiteral("localBaseUrl"), m_localBaseUrl.trimmed());
    m_settings.setValue(QStringLiteral("localApiKey"), m_localApiKey);
    m_settings.setValue(QStringLiteral("autoConnect"), m_autoConnect);
    m_settings.sync();
}

void AgentController::start() {
    m_reconnectTimer.stop();
    if (m_cloudUrl.trimmed().isEmpty() || m_providerId <= 0 || m_providerToken.isEmpty() || m_localBaseUrl.trimmed().isEmpty()) {
        emit notice(QStringLiteral("请完整填写云端地址、供应商 ID、连接凭据和本地服务地址"), true);
        return;
    }
    const QUrl cloud = endpoint();
    const QUrl local(m_localBaseUrl.trimmed());
    if (!cloud.isValid() || (cloud.scheme() != QStringLiteral("ws") && cloud.scheme() != QStringLiteral("wss")) || cloud.host().isEmpty()) {
        emit notice(QStringLiteral("云端地址无效，请使用 http:// 或 https:// 地址"), true);
        return;
    }
    if (!local.isValid() || local.host().isEmpty() || (local.scheme() != QStringLiteral("http") && local.scheme() != QStringLiteral("https"))) {
        emit notice(QStringLiteral("本地推理服务地址无效"), true);
        return;
    }
    saveSettings();
    m_manualStop = false;
    m_reconnectDelay = 1000;
    setConnectionState(QStringLiteral("connecting"));
    addLog(QStringLiteral("正在连接 %1").arg(cloud.toString()));
    m_transport.open(cloud);
    checkLocalHealth();
    if (m_autoConnect) saveSettings();
}

void AgentController::stop() {
    m_manualStop = true;
    m_reconnectTimer.stop();
    m_healthTimer.stop();
    abortRequests();
    setConnectionState(QStringLiteral("offline"));
    addLog(QStringLiteral("已停止本地代理"));
    m_transport.close();
}

void AgentController::setConnectionState(const QString &state) {
    if (m_connectionState == state) return;
    m_connectionState = state;
    emit connectionStateChanged();
}

void AgentController::setLocalStatus(bool online, int latency) {
    m_localOnline = online;
    m_localLatency = latency;
    emit localStatusChanged();
}

void AgentController::addLog(const QString &message) {
    m_logs.append(QStringLiteral("%1  %2").arg(QDateTime::currentDateTime().toString(QStringLiteral("HH:mm:ss")), message));
    while (m_logs.size() > 200) m_logs.removeFirst();
    emit logsChanged();
}

void AgentController::clearLogs() { m_logs.clear(); emit logsChanged(); }

void AgentController::sendJson(const QJsonObject &object) {
    m_transport.sendText(QString::fromUtf8(QJsonDocument(object).toJson(QJsonDocument::Compact)));
}

void AgentController::onCloudMessage(const QString &message) {
    QJsonParseError parseError;
    const QJsonDocument document = QJsonDocument::fromJson(message.toUtf8(), &parseError);
    if (parseError.error != QJsonParseError::NoError || !document.isObject()) return;
    const QJsonObject object = document.object();
    const QString type = object.value(QStringLiteral("type")).toString();
    if (type == QStringLiteral("auth_ok")) {
        m_providerName = object.value(QStringLiteral("provider")).toString();
        emit providerNameChanged();
        m_reconnectDelay = 1000;
        setConnectionState(QStringLiteral("online"));
        addLog(QStringLiteral("供应商“%1”已上线，开始接收云端请求").arg(m_providerName));
        emit notice(QStringLiteral("本地代理已上线"), false);
        m_healthTimer.start();
        checkLocalHealth();
    } else if (type == QStringLiteral("request")) {
        forwardRequest(object);
    } else if (type == QStringLiteral("cancel")) {
        const QString id = object.value(QStringLiteral("id")).toString();
        const auto request = m_requests.find(id);
        if (request != m_requests.end() && request->reply) request->reply->abort();
    }
}

void AgentController::checkLocalHealth() {
    if (m_healthReply) return;
    QString base = m_localBaseUrl.trimmed();
    if (base.endsWith(QLatin1Char('/'))) base.chop(1);
    QNetworkRequest request(QUrl(base + QStringLiteral("/v1/models")));
    request.setTransferTimeout(5000);
    if (!m_localApiKey.isEmpty()) request.setRawHeader("Authorization", "Bearer " + m_localApiKey.toUtf8());
    QNetworkReply *reply = m_network.get(request);
    m_healthReply = reply;
    QElapsedTimer timer;
    timer.start();
    connect(reply, &QNetworkReply::finished, this, [this, reply, timer] {
        const int status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
        const int latency = static_cast<int>(timer.elapsed());
        const bool online = status >= 200 && status < 300;
        setLocalStatus(online, latency);
        QString message;
        if (!online) message = status ? QStringLiteral("推理服务返回 HTTP %1").arg(status) : QStringLiteral("无法连接本地推理服务：%1").arg(reply->errorString());
        sendJson({{QStringLiteral("type"), QStringLiteral("health")},
                  {QStringLiteral("online"), online},
                  {QStringLiteral("latency"), latency},
                  {QStringLiteral("message"), message}});
        reply->deleteLater();
        m_healthReply = nullptr;
    });
}

void AgentController::forwardRequest(const QJsonObject &message) {
    const QString id = message.value(QStringLiteral("id")).toString();
    if (id.isEmpty() || m_requests.contains(id)) return;
    QString base = m_localBaseUrl.trimmed();
    if (base.endsWith(QLatin1Char('/'))) base.chop(1);
    QNetworkRequest request(QUrl(base + message.value(QStringLiteral("path")).toString()));
    request.setTransferTimeout(1800000);
    const QJsonObject headers = message.value(QStringLiteral("headers")).toObject();
    for (auto it = headers.begin(); it != headers.end(); ++it) request.setRawHeader(it.key().toUtf8(), it.value().toString().toUtf8());
    if (!m_localApiKey.isEmpty()) request.setRawHeader("Authorization", "Bearer " + m_localApiKey.toUtf8());
    const QByteArray body = QByteArray::fromBase64(message.value(QStringLiteral("body")).toString().toUtf8());
    QNetworkReply *reply = m_network.sendCustomRequest(request, message.value(QStringLiteral("method")).toString().toUtf8(), body);
    m_requests.insert(id, {reply, false});
    m_totalRequests++;
    emit totalRequestsChanged();
    emit activeRequestsChanged();
    addLog(QStringLiteral("开始转发 %1 %2").arg(message.value(QStringLiteral("method")).toString(), message.value(QStringLiteral("path")).toString()));
    connect(reply, &QNetworkReply::readyRead, this, [this, id] { streamReply(id); });
    connect(reply, &QNetworkReply::finished, this, [this, id] { finishReply(id); });
}

void AgentController::streamReply(const QString &id) {
    const auto it = m_requests.find(id);
    if (it == m_requests.end() || !it->reply) return;
    QNetworkReply *reply = it->reply;
    if (!it->headersSent) {
        QJsonObject headers;
        const QList<QByteArray> excluded = {"content-length", "content-encoding", "transfer-encoding", "connection"};
        const auto rawHeaders = reply->rawHeaderPairs();
        for (const auto &pair : rawHeaders) {
            const QString name = QString::fromUtf8(pair.first).toLower();
            if (!excluded.contains(pair.first.toLower())) headers.insert(name, QString::fromUtf8(pair.second));
        }
        sendJson({{QStringLiteral("type"), QStringLiteral("response")},
                  {QStringLiteral("id"), id},
                  {QStringLiteral("status"), reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt()},
                  {QStringLiteral("headers"), headers}});
        it->headersSent = true;
    }
    const QByteArray chunk = reply->readAll();
    if (!chunk.isEmpty()) {
        sendJson({{QStringLiteral("type"), QStringLiteral("chunk")},
                  {QStringLiteral("id"), id},
                  {QStringLiteral("data"), QString::fromLatin1(chunk.toBase64())}});
    }
}

void AgentController::finishReply(const QString &id) {
    const auto it = m_requests.find(id);
    if (it == m_requests.end() || !it->reply) return;
    QNetworkReply *reply = it->reply;
    if (reply->error() != QNetworkReply::NoError && reply->error() != QNetworkReply::OperationCanceledError) {
        addLog(QStringLiteral("本地转发失败：%1").arg(reply->errorString()));
        sendJson({{QStringLiteral("type"), QStringLiteral("error")},
                  {QStringLiteral("id"), id},
                  {QStringLiteral("message"), QStringLiteral("本地转发失败：%1").arg(reply->errorString())}});
    } else if (reply->error() == QNetworkReply::NoError) {
        streamReply(id);
        sendJson({{QStringLiteral("type"), QStringLiteral("end")}, {QStringLiteral("id"), id}});
        addLog(QStringLiteral("请求完成，HTTP %1").arg(reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt()));
    }
    reply->deleteLater();
    m_requests.erase(it);
    emit activeRequestsChanged();
}

void AgentController::abortRequests() {
    if (m_requests.isEmpty()) return;
    const auto replies = m_requests;
    m_requests.clear();
    emit activeRequestsChanged();
    for (const auto &request : replies) if (request.reply) request.reply->abort();
}
