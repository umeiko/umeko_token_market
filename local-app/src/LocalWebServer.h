#pragma once

#include <QJsonObject>
#include <QObject>

class AgentController;
class QTcpServer;
class QTcpSocket;

class LocalWebServer : public QObject {
    Q_OBJECT
public:
    explicit LocalWebServer(AgentController *agent, QObject *parent = nullptr);
    bool listen(quint16 port);
    quint16 port() const;

signals:
    void shutdownRequested();

private:
    void acceptConnections();
    void handleRequest(QTcpSocket *socket, const QByteArray &request);
    QJsonObject status() const;
    QJsonObject config() const;
    void applyConfig(const QJsonObject &object);
    static void send(QTcpSocket *socket, int status, const QByteArray &type, const QByteArray &body);
    static void sendJson(QTcpSocket *socket, const QJsonObject &object, int status = 200);

    AgentController *m_agent;
    QTcpServer *m_server;
};
