#include "AgentController.h"

#include <QDateTime>
#include <QJsonDocument>
#include <QJsonObject>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QRegularExpression>
#include <QUrl>
#include <memory>

AgentController::AgentController(const QString &profile, QObject *parent)
    : QObject(parent), m_settings(QStringLiteral("Umeko"),
        profile.isEmpty() ? QStringLiteral("utoken") : QStringLiteral("utoken-") + profile) {
    m_cloudUrl = m_settings.value(QStringLiteral("cloudUrl"), QStringLiteral("http://127.0.0.1:3000")).toString();
    m_providerId = m_settings.value(QStringLiteral("providerId"), 1).toInt();
    m_providerToken = m_settings.value(QStringLiteral("providerToken")).toString();
    m_localBaseUrl = m_settings.value(QStringLiteral("localBaseUrl"), QStringLiteral("http://127.0.0.1:8080")).toString();
    m_localApiKey = m_settings.value(QStringLiteral("localApiKey")).toString();
    m_serviceType = m_settings.value(QStringLiteral("serviceType"), QStringLiteral("api")).toString();
    m_healthPath = m_settings.value(QStringLiteral("healthPath"), QStringLiteral("/v1/models")).toString();
    m_modelId = m_settings.value(QStringLiteral("modelId")).toString();
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
                  {QStringLiteral("token"), m_providerToken},
                  {QStringLiteral("videoBridge"), true}});
    });
    connect(&m_transport, &WebSocketTransport::textMessageReceived, this, &AgentController::onCloudMessage);
    connect(&m_transport, &WebSocketTransport::errorOccurred, this, [this](const QString &message) {
        addLog(QStringLiteral("网络错误：%1").arg(message));
    });
    connect(&m_transport, &WebSocketTransport::disconnected, this, [this](const QString &reason) {
        m_healthTimer.stop();
        cancelHealth();
        abortRequests();
        m_cloudModels = {};
        m_providerName.clear();
        emit providerNameChanged();
        if (m_manualStop) {
            setConnectionState(QStringLiteral("offline"));
            return;
        }
        m_connectionError = reason;
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
    m_settings.setValue(QStringLiteral("serviceType"), m_serviceType);
    m_settings.setValue(QStringLiteral("healthPath"), m_healthPath);
    m_settings.setValue(QStringLiteral("modelId"), m_modelId);
    m_settings.sync();
}

void AgentController::removeConfiguration() {
    stop();
    setProviderToken({});
    setLocalApiKey({});
    setAutoConnect(false);
    m_modelId.clear();
    m_settings.clear();
    m_settings.sync();
}

void AgentController::start() {
    m_reconnectTimer.stop();
    if (m_cloudUrl.trimmed().isEmpty() || m_providerId <= 0 || m_providerToken.isEmpty() || m_localBaseUrl.trimmed().isEmpty()) {
        emit notice(QStringLiteral("请完整填写云端地址、供应商 ID、连接凭据和本地服务地址"), true);
        return;
    }
    const QUrl cloud = endpoint();
    if (!validBaseUrl(m_cloudUrl)) {
        emit notice(QStringLiteral("云端地址无效，请使用 http:// 或 https:// 地址"), true);
        return;
    }
    if (!validBaseUrl(m_localBaseUrl) || !validHealthPath(m_healthPath)
        || (m_serviceType != QStringLiteral("api") && m_serviceType != QStringLiteral("video"))) {
        emit notice(QStringLiteral("本地推理服务地址无效"), true);
        return;
    }
    m_healthTimer.stop();
    cancelHealth();
    abortRequests();
    saveSettings();
    m_connectionError.clear();
    m_providerName.clear();
    m_cloudModels = {};
    m_manualStop = false;
    m_reconnectDelay = 1000;
    setConnectionState(QStringLiteral("connecting"));
    addLog(QStringLiteral("正在连接 %1").arg(cloud.toString()));
    m_transport.open(cloud);
}

void AgentController::stop() {
    m_manualStop = true;
    m_reconnectTimer.stop();
    m_healthTimer.stop();
    cancelHealth();
    abortRequests();
    m_connectionError.clear();
    m_cloudModels = {};
    m_providerName.clear();
    emit providerNameChanged();
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
        const QString type = object.value(QStringLiteral("providerType")).toString(QStringLiteral("tunnel"));
        if ((type == QStringLiteral("video_tunnel")) != (m_serviceType == QStringLiteral("video"))) {
            stop();
            m_connectionError = QStringLiteral("供应商类型与本地连接配置不一致，请检查云端节点与服务类型");
            addLog(m_connectionError);
            return;
        }
        m_connectionError.clear();
        m_cloudModels = object.value(QStringLiteral("models")).toArray();
        m_providerName = object.value(QStringLiteral("provider")).toString();
        emit providerNameChanged();
        m_reconnectDelay = 1000;
        setConnectionState(QStringLiteral("online"));
        addLog(QStringLiteral("供应商“%1”已上线，开始接收云端请求").arg(m_providerName));
        emit notice(QStringLiteral("本地代理已上线"), false);
        m_healthTimer.start();
        checkLocalHealth();
    } else if (type == QStringLiteral("provider_info")) {
        m_cloudModels = object.value(QStringLiteral("models")).toArray();
    } else if (type == QStringLiteral("credit")) {
        const QString id = object.value(QStringLiteral("id")).toString();
        const auto request = m_requests.find(id);
        if (request != m_requests.end() && request->flowControl && request->waitingForCredit) {
            request->waitingForCredit = false;
            if (request->reply && request->reply->isFinished()) finishReply(id);
            else streamReply(id);
        }
    } else if (type == QStringLiteral("request") && m_connectionState == QStringLiteral("online")) {
        forwardRequest(object);
    } else if (type == QStringLiteral("cancel")) {
        const QString id = object.value(QStringLiteral("id")).toString();
        const auto request = m_requests.find(id);
        if (request != m_requests.end() && request->reply) request->reply->abort();
    }
}

bool AgentController::validBaseUrl(const QString &value) {
    const QUrl url(value.trimmed(), QUrl::StrictMode);
    return url.isValid() && !url.host().isEmpty()
        && (url.scheme() == QStringLiteral("http") || url.scheme() == QStringLiteral("https"))
        && url.userInfo().isEmpty() && !url.hasQuery() && !url.hasFragment();
}

bool AgentController::validHealthPath(const QString &value) {
    static const QRegularExpression path(QStringLiteral("^/[a-zA-Z0-9_./-]{0,200}$"));
    return path.match(value).hasMatch() && !value.startsWith(QStringLiteral("//"))
        && !value.split(QLatin1Char('/')).contains(QStringLiteral(".."));
}

void AgentController::redeemPairing(const QString &base, const QJsonObject &pairing,
                                    const std::function<void(const QJsonObject &)> &complete) {
    QNetworkRequest request(QUrl(base + QStringLiteral("/agent/pair")));
    request.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json"));
    request.setAttribute(QNetworkRequest::RedirectPolicyAttribute, QNetworkRequest::ManualRedirectPolicy);
    request.setTransferTimeout(7000);
    auto *reply = m_network.post(request, QJsonDocument(pairing).toJson(QJsonDocument::Compact));
    connect(reply, &QNetworkReply::readyRead, reply, [reply] {
        if (reply->bytesAvailable() > 4096) reply->abort();
    });
    connect(reply, &QNetworkReply::finished, this, [reply, pairing, complete] {
        const int status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
        const auto data = QJsonDocument::fromJson(reply->read(4096)).object();
        static const QRegularExpression token(QStringLiteral("^umo-agent-[a-zA-Z0-9_-]{32}$"));
        if (status == 200 && reply->error() == QNetworkReply::NoError
            && data.value(QStringLiteral("id")) == pairing.value(QStringLiteral("id"))
            && data.value(QStringLiteral("service")) == pairing.value(QStringLiteral("service"))
            && token.match(data.value(QStringLiteral("token")).toString()).hasMatch()) {
            complete(data);
        } else {
            const QString error = data.value(QStringLiteral("error")).toString().left(200);
            complete({{QStringLiteral("error"), error.isEmpty()
                ? QStringLiteral("云端配对服务未响应或尚未升级") : error}});
        }
        reply->deleteLater();
    });
}

void AgentController::probe(const QString &base, const QString &path, const QString &key,
                            const std::function<void(const QJsonObject &)> &complete) {
    const QUrl url(base.chopped(base.endsWith(QLatin1Char('/')) ? 1 : 0) + path);
    QNetworkRequest request(url);
    request.setTransferTimeout(5000);
    request.setAttribute(QNetworkRequest::RedirectPolicyAttribute, QNetworkRequest::ManualRedirectPolicy);
    if (!key.isEmpty()) request.setRawHeader("Authorization", "Bearer " + key.toUtf8());
    QNetworkReply *reply = m_network.get(request);
    QTimer::singleShot(5000, reply, [reply] { if (reply->isRunning()) reply->abort(); });
    QElapsedTimer timer;
    timer.start();
    auto body = std::make_shared<QByteArray>();
    const auto readBody = [reply, body] {
        const auto bytes = reply->readAll();
        if (reply->property("discoveryBodyTooLarge").toBool()) return;
        if (body->size() + bytes.size() > 256 * 1024) {
            body->clear();
            reply->setProperty("discoveryBodyTooLarge", true);
            return;
        }
        body->append(bytes);
    };
    connect(reply, &QNetworkReply::readyRead, reply, readBody);
    connect(reply, &QNetworkReply::finished, this, [reply, timer, complete, body, readBody] {
        const int status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
        const bool online = status >= 200 && status < 300 && reply->error() == QNetworkReply::NoError;
        QString message;
        if (!online) message = status ? QStringLiteral("本地服务返回 HTTP %1").arg(status)
                                      : QStringLiteral("无法连接本地服务或探测超时");
        QJsonArray models;
        if (online) {
            readBody();
            const auto document = QJsonDocument::fromJson(*body).object();
            const auto rows = document.value(QStringLiteral("data")).toArray();
            const auto add = [&models](const QString &id) {
                if (!id.isEmpty() && id.size() <= 256 && !models.contains(id)) models.append(id);
            };
            add(document.value(QStringLiteral("model")).toString());
            for (const auto &row : rows) {
                add(row.toObject().value(QStringLiteral("id")).toString());
                if (models.size() >= 200) break;
            }
        }
        complete({{QStringLiteral("online"), online}, {QStringLiteral("status"), status},
                  {QStringLiteral("latency"), static_cast<int>(timer.elapsed())},
                  {QStringLiteral("message"), message}, {QStringLiteral("models"), models}});
        reply->deleteLater();
    });
}

void AgentController::cancelHealth() {
    ++m_healthGeneration;
    m_checking = false;
    m_healthMessage.clear();
    m_localModels = {};
    setLocalStatus(false, -1);
}

void AgentController::checkLocalHealth() {
    if (m_checking || !validBaseUrl(m_localBaseUrl) || !validHealthPath(m_healthPath)) return;
    m_checking = true;
    const auto generation = m_healthGeneration;
    const auto report = [this, generation](QJsonObject result, QJsonArray models) {
        if (generation != m_healthGeneration) return;
        m_checking = false;
        if (models.isEmpty() && result.value(QStringLiteral("online")).toBool() && !m_modelId.isEmpty()) {
            models.append(m_modelId);
        }
        m_localModels = models;
        m_healthMessage = result.value(QStringLiteral("message")).toString();
        setLocalStatus(result.value(QStringLiteral("online")).toBool(), result.value(QStringLiteral("latency")).toInt());
        result.remove(QStringLiteral("models"));
        result.insert(QStringLiteral("type"), QStringLiteral("health"));
        result.insert(QStringLiteral("discovery"), QJsonObject{
            {QStringLiteral("models"), models}, {QStringLiteral("healthPath"), m_healthPath},
            {QStringLiteral("localAuth"), !m_localApiKey.isEmpty()}});
        if (m_connectionState == QStringLiteral("online")) sendJson(result);
    };
    probe(m_localBaseUrl.trimmed(), m_healthPath, m_localApiKey, [this, generation, report](const QJsonObject &result) {
        if (generation != m_healthGeneration) return;
        const auto models = result.value(QStringLiteral("models")).toArray();
        if (!models.isEmpty() || !result.value(QStringLiteral("online")).toBool()
            || m_healthPath == QStringLiteral("/v1/models")) {
            report(result, models);
            return;
        }
        probe(m_localBaseUrl.trimmed(), QStringLiteral("/v1/models"), m_localApiKey, [report, result](const QJsonObject &list) {
            report(result, list.value(QStringLiteral("models")).toArray());
        });
    });
}

void AgentController::forwardRequest(const QJsonObject &message) {
    const QString id = message.value(QStringLiteral("id")).toString();
    if (id.isEmpty() || m_requests.contains(id)) return;
    QString base = m_localBaseUrl.trimmed();
    if (base.endsWith(QLatin1Char('/'))) base.chop(1);
    QNetworkRequest request(QUrl(base + message.value(QStringLiteral("path")).toString()));
    request.setTransferTimeout(1800000);
    request.setAttribute(QNetworkRequest::RedirectPolicyAttribute, QNetworkRequest::ManualRedirectPolicy);
    const QJsonObject headers = message.value(QStringLiteral("headers")).toObject();
    for (auto it = headers.begin(); it != headers.end(); ++it) request.setRawHeader(it.key().toUtf8(), it.value().toString().toUtf8());
    if (!m_localApiKey.isEmpty()) request.setRawHeader("Authorization", "Bearer " + m_localApiKey.toUtf8());
    const QByteArray body = QByteArray::fromBase64(message.value(QStringLiteral("body")).toString().toUtf8());
    QNetworkReply *reply = m_network.sendCustomRequest(request, message.value(QStringLiteral("method")).toString().toUtf8(), body);
    const bool flowControl = message.value(QStringLiteral("flowControl")).toBool();
    if (flowControl) reply->setReadBufferSize(128 * 1024);
    m_requests.insert(id, {reply, false, flowControl, false});
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
    if (it->waitingForCredit) return;
    const QByteArray chunk = it->flowControl ? reply->read(128 * 1024) : reply->readAll();
    if (!chunk.isEmpty()) {
        it->waitingForCredit = it->flowControl;
        sendJson({{QStringLiteral("type"), QStringLiteral("chunk")},
                  {QStringLiteral("id"), id},
                  {QStringLiteral("data"), QString::fromLatin1(chunk.toBase64())}});
    }
}

void AgentController::finishReply(const QString &id) {
    const auto it = m_requests.find(id);
    if (it == m_requests.end() || !it->reply) return;
    QNetworkReply *reply = it->reply;
    const auto status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
    const bool httpError = status >= 400 && reply->error() >= QNetworkReply::ContentAccessDenied;
    if (reply->error() != QNetworkReply::NoError && !httpError && reply->error() != QNetworkReply::OperationCanceledError) {
        addLog(QStringLiteral("本地转发失败：%1").arg(reply->errorString()));
        sendJson({{QStringLiteral("type"), QStringLiteral("error")},
                  {QStringLiteral("id"), id},
                  {QStringLiteral("message"), QStringLiteral("本地转发失败：%1").arg(reply->errorString())}});
    } else if (reply->error() != QNetworkReply::OperationCanceledError) {
        streamReply(id);
        if (it->waitingForCredit) return;
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
