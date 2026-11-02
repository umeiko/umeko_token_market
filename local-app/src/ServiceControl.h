#pragma once

#include <QJsonObject>
#include <QString>

class ServiceControl {
public:
    static QJsonObject request(const QString &method, const QString &path, quint16 port, const QJsonObject &body = {}, bool *ok = nullptr, int timeoutMs = 1800);
    static bool running(quint16 port);
};
