#pragma once

#include <QJsonObject>
#include <QObject>
#include <QHash>
#include <QSettings>

class AgentController;
class QTcpServer;
class QTcpSocket;

class LocalWebServer : public QObject {
    Q_OBJECT
public:
    explicit LocalWebServer(AgentController *agent, const QString &profile = {}, QObject *parent = nullptr);
    bool listen(quint16 port);
    quint16 port() const;

signals:
    void shutdownRequested();

private:
    void acceptConnections(QTcpServer *server);
    void handleRequest(QTcpSocket *socket, const QByteArray &request);
    void pair(QTcpSocket *socket, const QString &id, AgentController *agent, const QJsonObject &data);
    QJsonObject models(const QString &preferred);
    static QJsonObject status(const AgentController *agent);
    static QJsonObject config(const AgentController *agent);
    void applyConfig(const QString &id, AgentController *agent, const QJsonObject &object);
    AgentController *addModelAgent(const QString &id);
    bool providerInUse(const AgentController *agent, const QString &cloud, int providerId) const;
    static void send(QTcpSocket *socket, int status, const QByteArray &type, const QByteArray &body);
    static void sendJson(QTcpSocket *socket, const QJsonObject &object, int status = 200);

    AgentController *m_agent;
    QTcpServer *m_server;
    QSettings m_catalog;
    QHash<QString, AgentController *> m_agents;
    QHash<quint16, QString> m_ports;
    bool m_pairing = false;
};
