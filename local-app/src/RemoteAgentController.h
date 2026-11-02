#pragma once

#include <QJsonObject>
#include <QNetworkAccessManager>
#include <QTimer>
#include <functional>

class RemoteAgentController : public QObject {
    Q_OBJECT
    Q_PROPERTY(QString cloudUrl READ cloudUrl WRITE setCloudUrl NOTIFY cloudUrlChanged)
    Q_PROPERTY(int providerId READ providerId WRITE setProviderId NOTIFY providerIdChanged)
    Q_PROPERTY(QString providerToken READ providerToken WRITE setProviderToken NOTIFY providerTokenChanged)
    Q_PROPERTY(QString localBaseUrl READ localBaseUrl WRITE setLocalBaseUrl NOTIFY localBaseUrlChanged)
    Q_PROPERTY(QString localApiKey READ localApiKey WRITE setLocalApiKey NOTIFY localApiKeyChanged)
    Q_PROPERTY(bool autoConnect READ autoConnect WRITE setAutoConnect NOTIFY autoConnectChanged)
    Q_PROPERTY(QString connectionState READ connectionState NOTIFY connectionStateChanged)
    Q_PROPERTY(QString providerName READ providerName NOTIFY statusChanged)
    Q_PROPERTY(bool localOnline READ localOnline NOTIFY statusChanged)
    Q_PROPERTY(int localLatency READ localLatency NOTIFY statusChanged)
    Q_PROPERTY(int activeRequests READ activeRequests NOTIFY statusChanged)
    Q_PROPERTY(int totalRequests READ totalRequests NOTIFY statusChanged)
    Q_PROPERTY(QStringList logs READ logs NOTIFY logsChanged)
public:
    explicit RemoteAgentController(quint16 port, QObject *parent = nullptr);
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
    int activeRequests() const { return m_activeRequests; }
    int totalRequests() const { return m_totalRequests; }
    QStringList logs() const { return m_logs; }
    void setCloudUrl(const QString &value) { m_cloudUrl = value; emit cloudUrlChanged(); }
    void setProviderId(int value) { m_providerId = value; emit providerIdChanged(); }
    void setProviderToken(const QString &value) { m_providerToken = value; emit providerTokenChanged(); }
    void setLocalBaseUrl(const QString &value) { m_localBaseUrl = value; emit localBaseUrlChanged(); }
    void setLocalApiKey(const QString &value) { m_localApiKey = value; emit localApiKeyChanged(); }
    void setAutoConnect(bool value) { m_autoConnect = value; emit autoConnectChanged(); }
    Q_INVOKABLE void start();
    Q_INVOKABLE void stop();
    Q_INVOKABLE void checkLocalHealth();
    Q_INVOKABLE void clearLogs();
signals:
    void cloudUrlChanged(); void providerIdChanged(); void providerTokenChanged();
    void localBaseUrlChanged(); void localApiKeyChanged(); void autoConnectChanged();
    void connectionStateChanged(); void statusChanged(); void logsChanged();
    void notice(const QString &message, bool isError);
private:
    QJsonObject config() const;
    void call(const QString &method, const QString &path, const QJsonObject &body, const std::function<void(const QJsonObject &, bool)> &callback);
    void refresh();
    void loadConfig();
    QNetworkAccessManager m_network;
    QTimer m_timer;
    quint16 m_port;
    QString m_cloudUrl, m_providerToken, m_localBaseUrl, m_localApiKey;
    int m_providerId = 1;
    bool m_autoConnect = false;
    QString m_connectionState = QStringLiteral("offline"), m_providerName;
    bool m_localOnline = false;
    int m_localLatency = -1, m_activeRequests = 0, m_totalRequests = 0;
    QStringList m_logs;
};
