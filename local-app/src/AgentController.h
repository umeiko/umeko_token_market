#pragma once

#include "WebSocketTransport.h"

#include <QElapsedTimer>
#include <QHash>
#include <QJsonArray>
#include <functional>
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
    explicit AgentController(const QString &profile = {}, QObject *parent = nullptr);

    QString cloudUrl() const { return m_cloudUrl; }
    int providerId() const { return m_providerId; }
    QString providerToken() const { return m_providerToken; }
    QString localBaseUrl() const { return m_localBaseUrl; }
    QString localApiKey() const { return m_localApiKey; }
    bool autoConnect() const { return m_autoConnect; }
    QString connectionState() const { return m_connectionState; }
    QString serviceType() const { return m_serviceType; }
    QString healthPath() const { return m_healthPath; }
    QString modelId() const { return m_modelId; }
    QString healthMessage() const { return m_healthMessage; }
    QJsonArray cloudModels() const { return m_cloudModels; }
    QJsonArray localModels() const { return m_localModels; }
    QString connectionError() const { return m_connectionError; }
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
    void setServiceType(const QString &value) { m_serviceType = value; }
    void setHealthPath(const QString &value) { m_healthPath = value; }
    void setModelId(const QString &value) { m_modelId = value; }
    void removeConfiguration();
    static bool validBaseUrl(const QString &value);
    static bool validHealthPath(const QString &value);
    void probe(const QString &base, const QString &path, const QString &key,
               const std::function<void(const QJsonObject &)> &complete);

    void redeemPairing(const QString &base, const QJsonObject &pairing,
                       const std::function<void(const QJsonObject &)> &complete);

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
        bool flowControl = false;
        bool waitingForCredit = false;
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
    void cancelHealth();

    WebSocketTransport m_transport;
    QNetworkAccessManager m_network;
    QSettings m_settings;
    QTimer m_reconnectTimer;
    QTimer m_healthTimer;
    bool m_checking = false;
    quint64 m_healthGeneration = 0;
    QHash<QString, RequestState> m_requests;
    QString m_cloudUrl;
    int m_providerId = 1;
    QString m_providerToken;
    QString m_localBaseUrl;
    QString m_localApiKey;
    QString m_serviceType;
    QString m_healthPath;
    QString m_modelId;
    QString m_healthMessage;
    QString m_connectionError;
    QJsonArray m_cloudModels;
    QJsonArray m_localModels;
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
