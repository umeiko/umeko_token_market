#pragma once

#include <QAbstractSocket>
#include <QByteArray>
#include <QString>
#include <QUrl>

class QTcpSocket;

class WebSocketTransport : public QObject {
    Q_OBJECT
public:
    explicit WebSocketTransport(QObject *parent = nullptr);
    ~WebSocketTransport() override;

    void open(const QUrl &url);
    void close();
    bool sendText(const QString &text);

signals:
    void connected();
    void disconnected(const QString &reason);
    void textMessageReceived(const QString &message);
    void errorOccurred(const QString &message);

private slots:
    void onConnected();
    void onReadyRead();
    void onDisconnected();
    void onSocketError(QAbstractSocket::SocketError error);

private:
    bool sendFrame(quint8 opcode, const QByteArray &payload);
    void processFrames();
    void resetSocket();

    QTcpSocket *m_socket = nullptr;
    QUrl m_url;
    QByteArray m_buffer;
    QByteArray m_fragment;
    QString m_key;
    bool m_handshakeComplete = false;
    bool m_manualClose = false;
    quint8 m_fragmentOpcode = 0;
};
