#include "LocalWebServer.h"

#include "AgentController.h"

#include <QFile>
#include <QHostAddress>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonParseError>
#include <QTcpServer>
#include <QTcpSocket>
#include <QUrl>

LocalWebServer::LocalWebServer(AgentController *agent, QObject *parent)
    : QObject(parent), m_agent(agent), m_server(new QTcpServer(this)) {
    connect(m_server, &QTcpServer::newConnection, this, &LocalWebServer::acceptConnections);
}

bool LocalWebServer::listen(quint16 port) { return m_server->listen(QHostAddress::LocalHost, port); }
quint16 LocalWebServer::port() const { return m_server->serverPort(); }

void LocalWebServer::acceptConnections() {
    while (QTcpSocket *socket = m_server->nextPendingConnection()) {
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
    QString host;
    for (const QByteArray &line : lines) {
        if (line.toLower().startsWith("host:")) host = QString::fromUtf8(line.mid(line.indexOf(':') + 1).trimmed());
    }
    if (!host.startsWith(QStringLiteral("127.0.0.1")) && !host.startsWith(QStringLiteral("localhost")) && !host.startsWith(QStringLiteral("[::1]"))) {
        sendJson(socket, {{QStringLiteral("error"), QStringLiteral("仅允许本机访问")}}, 403);
        return;
    }
    if (method == "GET" && path == QStringLiteral("/")) {
        QFile file(QStringLiteral(":/web/index.html"));
        if (!file.open(QIODevice::ReadOnly)) { sendJson(socket, {{QStringLiteral("error"), QStringLiteral("页面资源缺失")}}, 500); return; }
        send(socket, 200, "text/html; charset=utf-8", file.readAll());
        return;
    }
    if (method == "GET" && path == QStringLiteral("/api/status")) { sendJson(socket, status()); return; }
    if (method == "GET" && path == QStringLiteral("/api/config")) { sendJson(socket, config()); return; }
    if (method == "POST" && (path == QStringLiteral("/api/config") || path == QStringLiteral("/api/start"))) {
        QJsonParseError error;
        const QJsonDocument document = QJsonDocument::fromJson(request.mid(headerEnd + 4), &error);
        if (error.error != QJsonParseError::NoError || !document.isObject()) { sendJson(socket, {{QStringLiteral("error"), QStringLiteral("JSON 配置无效")}}, 400); return; }
        applyConfig(document.object());
        if (path == QStringLiteral("/api/start")) m_agent->start();
        else m_agent->save();
        sendJson(socket, {{QStringLiteral("ok"), true}});
        return;
    }
    if (method == "POST" && path == QStringLiteral("/api/stop")) { m_agent->stop(); sendJson(socket, {{QStringLiteral("ok"), true}}); return; }
    if (method == "POST" && path == QStringLiteral("/api/check")) { m_agent->checkLocalHealth(); sendJson(socket, {{QStringLiteral("ok"), true}}); return; }
    if (method == "POST" && path == QStringLiteral("/api/clear-logs")) { m_agent->clearLogs(); sendJson(socket, {{QStringLiteral("ok"), true}}); return; }
    if (method == "POST" && path == QStringLiteral("/api/shutdown")) {
        m_agent->stop();
        sendJson(socket, {{QStringLiteral("ok"), true}});
        emit shutdownRequested();
        return;
    }
    sendJson(socket, {{QStringLiteral("error"), QStringLiteral("Not found")}}, 404);
}

QJsonObject LocalWebServer::status() const {
    return {{QStringLiteral("connectionState"), m_agent->connectionState()},
            {QStringLiteral("providerName"), m_agent->providerName()},
            {QStringLiteral("localOnline"), m_agent->localOnline()},
            {QStringLiteral("localLatency"), m_agent->localLatency()},
            {QStringLiteral("activeRequests"), m_agent->activeRequests()},
            {QStringLiteral("totalRequests"), m_agent->totalRequests()},
            {QStringLiteral("logs"), QJsonArray::fromStringList(m_agent->logs())}};
}

QJsonObject LocalWebServer::config() const {
    return {{QStringLiteral("cloudUrl"), m_agent->cloudUrl()},
            {QStringLiteral("providerId"), m_agent->providerId()},
            {QStringLiteral("providerToken"), m_agent->providerToken()},
            {QStringLiteral("localBaseUrl"), m_agent->localBaseUrl()},
            {QStringLiteral("localApiKey"), m_agent->localApiKey()},
            {QStringLiteral("autoConnect"), m_agent->autoConnect()}};
}

void LocalWebServer::applyConfig(const QJsonObject &object) {
    if (object.contains(QStringLiteral("cloudUrl"))) m_agent->setCloudUrl(object.value(QStringLiteral("cloudUrl")).toString());
    if (object.contains(QStringLiteral("providerId"))) m_agent->setProviderId(object.value(QStringLiteral("providerId")).toInt());
    if (object.contains(QStringLiteral("providerToken"))) m_agent->setProviderToken(object.value(QStringLiteral("providerToken")).toString());
    if (object.contains(QStringLiteral("localBaseUrl"))) m_agent->setLocalBaseUrl(object.value(QStringLiteral("localBaseUrl")).toString());
    if (object.contains(QStringLiteral("localApiKey"))) m_agent->setLocalApiKey(object.value(QStringLiteral("localApiKey")).toString());
    if (object.contains(QStringLiteral("autoConnect"))) m_agent->setAutoConnect(object.value(QStringLiteral("autoConnect")).toBool());
}

void LocalWebServer::send(QTcpSocket *socket, int statusCode, const QByteArray &type, const QByteArray &body) {
    const QByteArray status = statusCode == 200 ? "OK" : (statusCode == 404 ? "Not Found" : "Error");
    socket->write("HTTP/1.1 " + QByteArray::number(statusCode) + " " + status + "\r\n"
                  + "Content-Type: " + type + "\r\n"
                  + "Content-Length: " + QByteArray::number(body.size()) + "\r\n"
                  + "Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n"
                  + "Content-Security-Policy: default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'\r\n"
                  + "Connection: close\r\n\r\n" + body);
    socket->disconnectFromHost();
}

void LocalWebServer::sendJson(QTcpSocket *socket, const QJsonObject &object, int status) {
    send(socket, status, "application/json; charset=utf-8", QJsonDocument(object).toJson(QJsonDocument::Compact));
}
