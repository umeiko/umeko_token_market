#include "LocalWebServer.h"

#include "AgentController.h"

#include <QFile>
#include <QHostAddress>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonParseError>
#include <QPointer>
#include <QRegularExpression>
#include <QTcpServer>
#include <QTcpSocket>
#include <QUrl>
#include <QUrlQuery>
#include <QUuid>

namespace {
const QString DefaultModel = QStringLiteral("default");
const QString ModelPrefix = QStringLiteral("models/");

QString modelName(const QJsonObject &data) { return data.value(QStringLiteral("name")).toString().trimmed(); }

bool validModelMetadata(const QJsonObject &data) {
    static const QRegularExpression control(QStringLiteral("[\\x00-\\x1f\\x7f]"));
    for (const auto &field : {QStringLiteral("name"), QStringLiteral("modelId")}) {
        if (!data.contains(field)) continue;
        const auto value = data.value(field);
        const auto label = value.toString().trimmed();
        if (!value.isString() || control.match(label).hasMatch()) return false;
        if (field == QStringLiteral("name") && (label.isEmpty() || label.size() > 100)) return false;
        if (field == QStringLiteral("modelId") && label.size() > 256) return false;
    }
    return true;
}
}

LocalWebServer::LocalWebServer(AgentController *agent, const QString &profile, QObject *parent)
    : QObject(parent), m_agent(agent), m_server(new QTcpServer(this)),
      m_catalog(QStringLiteral("Umeko"), profile.isEmpty() ? QStringLiteral("utoken-models")
          : QStringLiteral("utoken-models-") + profile) {
    connect(m_server, &QTcpServer::newConnection, this, [this] { acceptConnections(m_server); });
}

bool LocalWebServer::listen(quint16 port) {
    if (!m_server->listen(QHostAddress::LocalHost, port)) return false;
    m_catalog.beginGroup(QStringLiteral("models"));
    const auto ids = m_catalog.childKeys();
    m_catalog.endGroup();
    for (const auto &id : ids) {
        static const QRegularExpression validId(QStringLiteral("^[a-zA-Z0-9_-]{1,40}$"));
        if (!validId.match(id).hasMatch()) continue;
        auto *agent = addModelAgent(id);
        if (agent != m_agent) {
            if (agent->autoConnect() && !agent->providerToken().isEmpty()) agent->start();
            else agent->checkLocalHealth();
        }
    }
    if (!m_agent->providerToken().isEmpty()) m_agents.insert(DefaultModel, m_agent);
    m_catalog.beginGroup(QStringLiteral("compatibility"));
    for (const auto &key : m_catalog.childKeys()) {
        bool valid = false;
        const quint16 legacyPort = key.toUShort(&valid);
        if (!valid || legacyPort < 1024 || legacyPort == m_server->serverPort()) continue;
        const QString id = m_catalog.value(key).toString();
        auto *server = new QTcpServer(this);
        if (!server->listen(QHostAddress::LocalHost, legacyPort)) {
            qWarning("Unable to listen on former management port %u", legacyPort);
            delete server;
            continue;
        }
        m_ports.insert(legacyPort, id);
        connect(server, &QTcpServer::newConnection, this, [this, server] { acceptConnections(server); });
    }
    m_catalog.endGroup();
    return true;
}
quint16 LocalWebServer::port() const { return m_server->serverPort(); }

AgentController *LocalWebServer::addModelAgent(const QString &id) {
    auto *agent = id == DefaultModel ? m_agent : new AgentController(id, this);
    m_agents.insert(id, agent);
    return agent;
}

bool LocalWebServer::providerInUse(const AgentController *agent, const QString &cloud, int providerId) const {
    for (const auto *other : m_agents) {
        if (other != agent && !other->providerToken().isEmpty() && other->providerId() == providerId
            && QUrl(other->cloudUrl().trimmed()).matches(QUrl(cloud.trimmed()), QUrl::StripTrailingSlash)) return true;
    }
    return false;
}

void LocalWebServer::acceptConnections(QTcpServer *server) {
    while (QTcpSocket *socket = server->nextPendingConnection()) {
        connect(socket, &QTcpSocket::readyRead, this, [this, socket, buffer = QByteArray()]() mutable {
            buffer.append(socket->readAll());
            const qint64 headerEnd = buffer.indexOf("\r\n\r\n");
            if (headerEnd < 0) {
                if (buffer.size() > 65536) socket->disconnectFromHost();
                return;
            }
            const QList<QByteArray> lines = buffer.left(headerEnd).split('\n');
            qint64 contentLength = 0;
            for (const QByteArray &line : lines) {
                if (line.toLower().startsWith("content-length:")) contentLength = line.mid(line.indexOf(':') + 1).trimmed().toLongLong();
            }
            if (contentLength > 1024 * 1024) {
                sendJson(socket, {{QStringLiteral("error"), QStringLiteral("请求过大")}}, 413);
                return;
            }
            if (buffer.size() < headerEnd + 4 + contentLength) return;
            handleRequest(socket, buffer);
            buffer.clear();
        });
        connect(socket, &QTcpSocket::disconnected, socket, &QTcpSocket::deleteLater);
    }
}

void LocalWebServer::handleRequest(QTcpSocket *socket, const QByteArray &request) {
    const qint64 headerEnd = request.indexOf("\r\n\r\n");
    const QList<QByteArray> lines = request.left(headerEnd).split('\n');
    const QList<QByteArray> parts = lines.value(0).trimmed().split(' ');
    if (parts.size() < 2) { sendJson(socket, {{QStringLiteral("error"), QStringLiteral("无效请求")}}, 400); return; }
    const QByteArray method = parts.at(0);
    const QUrl url(QString::fromUtf8(parts.at(1)));
    const QString path = url.path();
    QByteArray host, origin, type;
    for (const QByteArray &line : lines) {
        const int separator = line.indexOf(':');
        if (separator < 0) continue;
        const auto name = line.left(separator).trimmed().toLower();
        const auto value = line.mid(separator + 1).trimmed();
        if (name == "host") host = value.toLower();
        else if (name == "origin") origin = value;
        else if (name == "content-type") type = value.split(';').first().trimmed().toLower();
    }
    const QByteArray suffix = ":" + QByteArray::number(socket->localPort());
    if (host != "127.0.0.1" + suffix && host != "localhost" + suffix) {
        sendJson(socket, {{QStringLiteral("error"), QStringLiteral("仅允许从本机管理端口访问")}}, 403);
        return;
    }
    if (!origin.isEmpty() && origin != "http://" + host) {
        sendJson(socket, {{QStringLiteral("error"), QStringLiteral("拒绝跨站访问")}}, 403);
        return;
    }
    if (method == "POST" && type != "application/json") {
        sendJson(socket, {{QStringLiteral("error"), QStringLiteral("管理请求需要 JSON")}}, 415);
        return;
    }
    if (method == "GET" && path == QStringLiteral("/")) {
        QFile file(QStringLiteral(":/web/index.html"));
        if (!file.open(QIODevice::ReadOnly)) { sendJson(socket, {{QStringLiteral("error"), QStringLiteral("页面资源缺失")}}, 500); return; }
        send(socket, 200, "text/html; charset=utf-8", file.readAll());
        return;
    }
    const QString preferred = m_ports.value(socket->localPort(), DefaultModel);
    const QUrlQuery query(url);
    const QString selected = query.queryItemValue(QStringLiteral("model"));
    const QString id = selected.isEmpty() ? preferred : selected;
    const auto fail = [socket](const QString &message, int status = 400) {
        sendJson(socket, {{QStringLiteral("error"), message}}, status);
    };
    if (method == "GET" && path == QStringLiteral("/api/models")) { sendJson(socket, models(preferred)); return; }
    AgentController *agent = m_agents.value(id);
    if (!agent && id == DefaultModel && selected.isEmpty()) agent = m_agent;
    const bool create = method == "POST" && path == QStringLiteral("/api/models");
    if (!agent && !create) { fail(QStringLiteral("模型配置不存在"), 404); return; }
    if (method == "GET" && path == QStringLiteral("/api/status")) { sendJson(socket, status(agent)); return; }
    if (method == "GET" && path == QStringLiteral("/api/config")) {
        auto result = config(agent);
        result.insert(QStringLiteral("name"), m_catalog.value(ModelPrefix + id, id).toString());
        sendJson(socket, result);
        return;
    }
    if (method == "POST" && path == QStringLiteral("/api/models/delete")) {
        if (origin.isEmpty()) { fail(QStringLiteral("请从本机控制台删除模型"), 403); return; }
        if (!m_agents.contains(id)) { fail(QStringLiteral("模型配置不存在"), 404); return; }
        if (m_pairing || agent->activeRequests()) {
            fail(QStringLiteral("连接器正在配对或处理请求，请稍后再试"), 409);
            return;
        }
        m_agents.remove(id);
        m_catalog.remove(ModelPrefix + id);
        m_catalog.sync();
        agent->removeConfiguration();
        if (agent != m_agent) agent->deleteLater();
        sendJson(socket, {{QStringLiteral("ok"), true}});
        return;
    }
    const bool probe = path == QStringLiteral("/api/probe");
    const bool pairRequest = path == QStringLiteral("/api/pair");
    const bool start = path == QStringLiteral("/api/start");
    if (method == "POST" && (create || pairRequest || start || probe || path == QStringLiteral("/api/config"))) {
        QJsonParseError error;
        const QJsonDocument document = QJsonDocument::fromJson(request.mid(headerEnd + 4), &error);
        if (error.error != QJsonParseError::NoError || !document.isObject()) {
            fail(QStringLiteral("JSON 配置无效"));
            return;
        }
        auto data = document.object();
        if (!validModelMetadata(data)) { fail(QStringLiteral("请检查模型名称和模型 ID")); return; }
        if (m_pairing && !probe) { fail(QStringLiteral("正在配对，请等待完成"), 409); return; }
        if (pairRequest) {
            if (origin.isEmpty()) { fail(QStringLiteral("请从本机控制台发起配对"), 403); return; }
            pair(socket, id, agent, data);
            return;
        }
        const QString base = data.value(QStringLiteral("localBaseUrl")).toString(agent ? agent->localBaseUrl() : QString()).trimmed();
        const QString health = data.value(QStringLiteral("healthPath")).toString(agent ? agent->healthPath() : QString()).trimmed();
        const QString service = data.value(QStringLiteral("serviceType")).toString(agent ? agent->serviceType() : QString());
        if (!AgentController::validBaseUrl(base) || !AgentController::validHealthPath(health)
            || (service != QStringLiteral("api") && service != QStringLiteral("video"))) {
            fail(QStringLiteral("请检查本地 URL、健康检查路径和服务类型"));
            return;
        }
        if (create) {
            if (origin.isEmpty()) { fail(QStringLiteral("请从本机控制台新建模型"), 403); return; }
            if (modelName(data).isEmpty()) { fail(QStringLiteral("请输入模型名称")); return; }
            const QString newId = QUuid::createUuid().toString(QUuid::WithoutBraces);
            auto *created = addModelAgent(newId);
            QJsonObject localConfig = {{QStringLiteral("name"), modelName(data)}, {QStringLiteral("localBaseUrl"), base},
                {QStringLiteral("healthPath"), health}, {QStringLiteral("serviceType"), service},
                {QStringLiteral("modelId"), data.value(QStringLiteral("modelId")).toString()},
                {QStringLiteral("localApiKey"), data.value(QStringLiteral("localApiKey")).toString()},
                {QStringLiteral("autoConnect"), data.value(QStringLiteral("autoConnect")).toBool()}};
            applyConfig(newId, created, localConfig);
            created->save();
            created->checkLocalHealth();
            sendJson(socket, {{QStringLiteral("id"), newId}}, 201);
            return;
        }
        if (probe) {
            const QString key = data.value(QStringLiteral("localApiKey")).toString(agent->localApiKey());
            agent->probe(base, health, key, [connected = QPointer<QTcpSocket>(socket)](const QJsonObject &result) {
                if (connected) sendJson(connected, result);
            });
            return;
        }
        if (data.value(QStringLiteral("clearPairing")).toBool()) {
            data.insert(QStringLiteral("providerToken"), QString());
        }
        const QString cloud = data.value(QStringLiteral("cloudUrl")).toString(agent->cloudUrl()).trimmed();
        const QString token = data.value(QStringLiteral("providerToken")).toString(agent->providerToken());
        const int providerId = data.value(QStringLiteral("providerId")).toInt(agent->providerId());
        if ((start || !token.isEmpty()) && (!AgentController::validBaseUrl(cloud) || providerId < 1 || token.isEmpty())) {
            fail(QStringLiteral("请填写有效的云端地址、供应商 ID 和连接凭据"));
            return;
        }
        if (!token.isEmpty() && providerInUse(agent, cloud, providerId)) {
            fail(QStringLiteral("这个云端供应商已由另一模型连接"), 409);
            return;
        }
        if (service != agent->serviceType() && !agent->providerToken().isEmpty() && !token.isEmpty()
            && !data.contains(QStringLiteral("providerToken"))) {
            fail(QStringLiteral("更改模型类别需要使用对应类型的配对链接，或先解除当前配对"), 409);
            return;
        }
        const bool connected = agent->connectionState() != QStringLiteral("offline");
        const bool changed = base != agent->localBaseUrl() || health != agent->healthPath() || service != agent->serviceType()
            || cloud != agent->cloudUrl() || token != agent->providerToken() || providerId != agent->providerId()
            || data.value(QStringLiteral("localApiKey")).toString(agent->localApiKey()) != agent->localApiKey();
        if ((start || changed) && agent->activeRequests()) {
            fail(QStringLiteral("正在转发请求，请等待完成再应用连接设置"), 409);
            return;
        }
        if (connected && changed) agent->stop();
        applyConfig(id, agent, data);
        if (!m_agents.contains(id) && !agent->providerToken().isEmpty()) addModelAgent(id);
        if (start || (connected && changed && !token.isEmpty())) agent->start();
        else {
            agent->save();
            if (!connected || changed) agent->checkLocalHealth();
        }
        sendJson(socket, {{QStringLiteral("ok"), true}});
        return;
    }
    if (method == "POST" && path == QStringLiteral("/api/stop")) { agent->stop(); sendJson(socket, {{QStringLiteral("ok"), true}}); return; }
    if (method == "POST" && path == QStringLiteral("/api/check")) { agent->checkLocalHealth(); sendJson(socket, {{QStringLiteral("ok"), true}}); return; }
    if (method == "POST" && path == QStringLiteral("/api/clear-logs")) { agent->clearLogs(); sendJson(socket, {{QStringLiteral("ok"), true}}); return; }
    if (method == "POST" && path == QStringLiteral("/api/shutdown")) {
        agent->stop();
        sendJson(socket, {{QStringLiteral("ok"), true}});
        emit shutdownRequested();
        return;
    }
    fail(QStringLiteral("Not found"), 404);
}

void LocalWebServer::pair(QTcpSocket *socket, const QString &model, AgentController *agent, const QJsonObject &data) {
    const auto fail = [socket](const QString &message, int status = 400) {
        sendJson(socket, {{QStringLiteral("error"), message}}, status);
    };
    if (m_pairing || agent->activeRequests()) {
        fail(QStringLiteral("连接器正在配对或处理请求，请稍后再试"), 409);
        return;
    }
    const QString link = data.value(QStringLiteral("link")).toString().trimmed();
    QUrl url(link, QUrl::StrictMode);
    const QUrlQuery fragment(url.fragment());
    const QString service = fragment.queryItemValue(QStringLiteral("service"));
    const QString code = fragment.queryItemValue(QStringLiteral("code"));
    bool validId = false;
    const int id = fragment.queryItemValue(QStringLiteral("id")).toInt(&validId);
    url.setFragment(QString());
    const QString cloud = url.toString(QUrl::RemoveFragment | QUrl::StripTrailingSlash);
    static const QRegularExpression codePattern(QStringLiteral("^[a-zA-Z0-9_-]{32}$"));
    const bool loopback = url.host() == QStringLiteral("127.0.0.1") || url.host() == QStringLiteral("localhost");
    if (link.size() > 2048 || !AgentController::validBaseUrl(cloud) || (url.scheme() != QStringLiteral("https") && !loopback)
        || fragment.queryItemValue(QStringLiteral("utoken")) != QStringLiteral("1") || !validId || id < 1
        || !codePattern.match(code).hasMatch() || (service != QStringLiteral("api") && service != QStringLiteral("video"))) {
        fail(QStringLiteral("请粘贴云端「供应商与模型」生成的完整配对链接"));
        return;
    }
    if (providerInUse(agent, cloud, id)) {
        fail(QStringLiteral("这个云端供应商已由另一模型连接"), 409);
        return;
    }
    const QString defaultHealth = service == QStringLiteral("video") ? QStringLiteral("/health") : QStringLiteral("/v1/models");
    const QString base = data.value(QStringLiteral("localBaseUrl")).toString().trimmed();
    QString health = data.value(QStringLiteral("healthPath")).toString().trimmed();
    if (health.isEmpty()) health = defaultHealth;
    if (!AgentController::validBaseUrl(base) || !AgentController::validHealthPath(health)) {
        fail(QStringLiteral("请填写本地服务地址，并检查健康检查路径"));
        return;
    }
    QJsonObject config = data;
    config.remove(QStringLiteral("link"));
    config.insert(QStringLiteral("cloudUrl"), cloud);
    config.insert(QStringLiteral("providerId"), id);
    config.insert(QStringLiteral("serviceType"), service);
    config.insert(QStringLiteral("localBaseUrl"), base);
    config.insert(QStringLiteral("healthPath"), health);
    m_pairing = true;
    agent->redeemPairing(cloud, {{QStringLiteral("id"), id}, {QStringLiteral("code"), code}, {QStringLiteral("service"), service}},
        [this, agent, model, connected = QPointer<QTcpSocket>(socket), config](const QJsonObject &result) mutable {
            m_pairing = false;
            if (result.contains(QStringLiteral("error"))) {
                if (connected) sendJson(connected, result, 400);
                return;
            }
            config.insert(QStringLiteral("providerToken"), result.value(QStringLiteral("token")));
            applyConfig(model, agent, config);
            m_agents.insert(model, agent);
            agent->start();
            if (connected) sendJson(connected, {{QStringLiteral("ok"), true}});
        });
}

QJsonObject LocalWebServer::status(const AgentController *agent) {
    return {{QStringLiteral("connectionState"), agent->connectionState()},
            {QStringLiteral("providerName"), agent->providerName()},
            {QStringLiteral("localOnline"), agent->localOnline()},
            {QStringLiteral("localLatency"), agent->localLatency()},
            {QStringLiteral("healthMessage"), agent->healthMessage()},
            {QStringLiteral("connectionError"), agent->connectionError()},
            {QStringLiteral("cloudModels"), agent->cloudModels()},
            {QStringLiteral("localModels"), agent->localModels()},
            {QStringLiteral("activeRequests"), agent->activeRequests()},
            {QStringLiteral("totalRequests"), agent->totalRequests()},
            {QStringLiteral("logs"), QJsonArray::fromStringList(agent->logs())}};
}

QJsonObject LocalWebServer::config(const AgentController *agent) {
    return {{QStringLiteral("cloudUrl"), agent->cloudUrl()},
            {QStringLiteral("providerId"), agent->providerId()},
            {QStringLiteral("hasProviderToken"), !agent->providerToken().isEmpty()},
            {QStringLiteral("localBaseUrl"), agent->localBaseUrl()},
            {QStringLiteral("hasLocalApiKey"), !agent->localApiKey().isEmpty()},
            {QStringLiteral("serviceType"), agent->serviceType()},
            {QStringLiteral("modelId"), agent->modelId()},
            {QStringLiteral("healthPath"), agent->healthPath()},
            {QStringLiteral("autoConnect"), agent->autoConnect()}};
}

QJsonObject LocalWebServer::models(const QString &preferred) {
    QJsonArray rows;
    auto ids = m_agents.keys();
    ids.sort();
    for (const auto &id : ids) {
        auto *agent = m_agents.value(id);
        const QString name = m_catalog.value(ModelPrefix + id,
            agent->providerName().isEmpty() ? QStringLiteral("默认模型") : agent->providerName()).toString();
        rows.append(QJsonObject{{QStringLiteral("id"), id}, {QStringLiteral("name"), name},
            {QStringLiteral("serviceType"), agent->serviceType()}, {QStringLiteral("modelId"), agent->modelId()},
            {QStringLiteral("connectionState"), agent->connectionState()}, {QStringLiteral("localOnline"), agent->localOnline()},
            {QStringLiteral("hasProviderToken"), !agent->providerToken().isEmpty()}});
    }
    return {{QStringLiteral("models"), rows}, {QStringLiteral("preferred"), preferred}};
}

void LocalWebServer::applyConfig(const QString &id, AgentController *agent, const QJsonObject &object) {
    if (object.contains(QStringLiteral("name"))) {
        m_catalog.setValue(ModelPrefix + id, modelName(object));
        m_catalog.sync();
    }
    if (object.contains(QStringLiteral("modelId"))) agent->setModelId(object.value(QStringLiteral("modelId")).toString().trimmed());
    if (object.contains(QStringLiteral("cloudUrl"))) agent->setCloudUrl(object.value(QStringLiteral("cloudUrl")).toString());
    if (object.contains(QStringLiteral("providerId"))) agent->setProviderId(object.value(QStringLiteral("providerId")).toInt());
    if (object.contains(QStringLiteral("providerToken"))) agent->setProviderToken(object.value(QStringLiteral("providerToken")).toString());
    if (object.contains(QStringLiteral("localBaseUrl"))) agent->setLocalBaseUrl(object.value(QStringLiteral("localBaseUrl")).toString());
    if (object.contains(QStringLiteral("localApiKey"))) agent->setLocalApiKey(object.value(QStringLiteral("localApiKey")).toString());
    if (object.contains(QStringLiteral("serviceType"))) agent->setServiceType(object.value(QStringLiteral("serviceType")).toString());
    if (object.contains(QStringLiteral("healthPath"))) agent->setHealthPath(object.value(QStringLiteral("healthPath")).toString().trimmed());
    if (object.contains(QStringLiteral("autoConnect"))) agent->setAutoConnect(object.value(QStringLiteral("autoConnect")).toBool());
}

void LocalWebServer::send(QTcpSocket *socket, int statusCode, const QByteArray &type, const QByteArray &body) {
    const QByteArray status = statusCode == 200 ? "OK" : (statusCode == 404 ? "Not Found" : "Error");
    socket->write("HTTP/1.1 " + QByteArray::number(statusCode) + " " + status + "\r\n"
                  + "Content-Type: " + type + "\r\n"
                  + "Content-Length: " + QByteArray::number(body.size()) + "\r\n"
                  + "Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n"
                  + "Content-Security-Policy: default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'\r\n"
                  + "Connection: close\r\n\r\n" + body);
    socket->disconnectFromHost();
}

void LocalWebServer::sendJson(QTcpSocket *socket, const QJsonObject &object, int status) {
    send(socket, status, "application/json; charset=utf-8", QJsonDocument(object).toJson(QJsonDocument::Compact));
}
