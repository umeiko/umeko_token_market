#pragma once

#include "WebSocketTransport.h"

#include <QElapsedTimer>
#include <QHash>
#include <QNetworkAccessManager>
#include <QPointer>
#include <QSettings>
#include <QTimer>

class QNetworkReply;

class AgentController : public QObject {
    Q_OBJECT
    Q_PROPERTY(QString cloudUrl READ cloudUrl WRITE setCloudUrl NOTIFY cloudUrlChanged)
    Q_PROPERTY(int providerId READ providerId WRITE setProviderId NOTIFY providerIdChanged)
    Q_PROPERTY(QString providerToken READ providerToken WRITE setProviderToken NOTIFY providerTokenChanged)
    Q_PROPERTY(QString localBaseUrl READ localBaseUrl WRITE setLocalBaseUrl NOTIFY localBaseUrlChanged)
    Q_PROPERTY(QString localApiKey READ localApiKey WRITE setLocalApiKey NOTIFY localApiKeyChanged)
    Q_PROPERTY(bool autoConnect READ autoConnect WRITE setAutoConnect NOTIFY autoConnectChanged)
    Q_PROPERTY(QString connectionState READ connectionState NOTIFY connectionStateChanged)
    Q_PROPERTY(QString providerName READ providerName NOTIFY providerNameChanged)
    Q_PROPERTY(bool localOnline READ localOnline NOTIFY localStatusChanged)
    Q_PROPERTY(int localLatency READ localLatency NOTIFY localStatusChanged)
    Q_PROPERTY(int activeRequests READ activeRequests NOTIFY activeRequestsChanged)
    Q_PROPERTY(int totalRequests READ totalRequests NOTIFY totalRequestsChanged)
    Q_PROPERTY(QStringList logs READ logs NOTIFY logsChanged)

public:
    explicit AgentController(QObject *parent = nullptr);

    QString cloudUrl() const { return m_cloudUrl; }
    int providerId() const { return m_providerId; }
    QString providerToken() const { return m_providerToken; }
    QString localBaseUrl() const { return m_localBaseUrl; }
    QString localApiKey() const { return m_localApiKey; }
    bool autoConnect() const { return m_autoConnect; }
    QString connectionState() const { return m_connectionState; }
    QString providerName() const { return m_providerName; }
    bool localOnline() const { return m_localOnline; }
    int localLatency() const { return m_localLatency; }
    int activeRequests() const { return m_requests.size(); }
    int totalRequests() const { return m_totalRequests; }
    QStringList logs() const { return m_logs; }

    void setCloudUrl(const QString &value);
    void setProviderId(int value);
    void setProviderToken(const QString &value);
    void setLocalBaseUrl(const QString &value);
    void setLocalApiKey(const QString &value);
    void setAutoConnect(bool value);

    Q_INVOKABLE void start();
    Q_INVOKABLE void stop();
    Q_INVOKABLE void checkLocalHealth();
    Q_INVOKABLE void clearLogs();
    void save() { saveSettings(); }

signals:
    void cloudUrlChanged();
    void providerIdChanged();
    void providerTokenChanged();
    void localBaseUrlChanged();
    void localApiKeyChanged();
    void autoConnectChanged();
    void connectionStateChanged();
    void providerNameChanged();
    void localStatusChanged();
    void activeRequestsChanged();
    void totalRequestsChanged();
    void logsChanged();
    void notice(const QString &message, bool isError);

private:
    struct RequestState {
        QPointer<QNetworkReply> reply;
        bool headersSent = false;
    };

    QUrl endpoint() const;
    void saveSettings();
    void setConnectionState(const QString &state);
    void setLocalStatus(bool online, int latency);
    void addLog(const QString &message);
    void sendJson(const QJsonObject &object);
    void onCloudMessage(const QString &message);
    void forwardRequest(const QJsonObject &message);
    void streamReply(const QString &id);
    void finishReply(const QString &id);
    void abortRequests();

    WebSocketTransport m_transport;
    QNetworkAccessManager m_network;
    QSettings m_settings;
    QTimer m_reconnectTimer;
    QTimer m_healthTimer;
    QPointer<QNetworkReply> m_healthReply;
    QHash<QString, RequestState> m_requests;
    QString m_cloudUrl;
    int m_providerId = 1;
    QString m_providerToken;
    QString m_localBaseUrl;
    QString m_localApiKey;
    bool m_autoConnect = false;
    QString m_connectionState = QStringLiteral("offline");
    QString m_providerName;
    bool m_localOnline = false;
    int m_localLatency = -1;
    int m_totalRequests = 0;
    QStringList m_logs;
    int m_reconnectDelay = 1000;
    bool m_manualStop = true;
};
