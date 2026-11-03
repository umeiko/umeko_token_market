#include "ServiceControl.h"

#include <QEventLoop>
#include <QJsonDocument>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QTimer>
#include <QUrl>

QJsonObject ServiceControl::request(const QString &method, const QString &path, quint16 port, const QJsonObject &body, bool *ok, int timeoutMs) {
    if (ok) *ok = false;
    QNetworkAccessManager network;
    QNetworkRequest request(QUrl(QStringLiteral("http://127.0.0.1:%1%2").arg(port).arg(path)));
    request.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json"));
    const QByteArray payload = QJsonDocument(body).toJson(QJsonDocument::Compact);
    QNetworkReply *reply = method == QStringLiteral("GET") ? network.get(request) : network.sendCustomRequest(request, method.toUtf8(), payload);
    QEventLoop loop;
    QTimer timer;
    timer.setSingleShot(true);
    QObject::connect(&timer, &QTimer::timeout, reply, &QNetworkReply::abort);
    QObject::connect(reply, &QNetworkReply::finished, &loop, &QEventLoop::quit);
    timer.start(timeoutMs);
    loop.exec();
    const QByteArray data = reply->readAll();
    const QJsonDocument document = QJsonDocument::fromJson(data);
    bool success = reply->error() == QNetworkReply::NoError && document.isObject();
    if (success && path == QStringLiteral("/api/status")) {
        const QJsonObject status = document.object();
        success = status.contains(QStringLiteral("connectionState"))
            && status.contains(QStringLiteral("localOnline"))
            && status.contains(QStringLiteral("totalRequests"));
    }
    if (ok) *ok = success;
    reply->deleteLater();
    return document.object();
}

bool ServiceControl::running(quint16 port) {
    bool ok = false;
    request(QStringLiteral("GET"), QStringLiteral("/api/status"), port, {}, &ok, 500);
    return ok;
}
