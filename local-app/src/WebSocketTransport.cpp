#include "WebSocketTransport.h"

#include <QCryptographicHash>
#include <QHostAddress>
#include <QRandomGenerator>
#include <QSslSocket>
#include <QTcpSocket>

namespace {
constexpr qint64 MaxFrameSize = 24 * 1024 * 1024;

QByteArray randomMask() {
    QByteArray bytes(4, 0);
    for (char &byte : bytes) byte = static_cast<char>(QRandomGenerator::global()->generate() & 0xff);
    return bytes;
}
}

WebSocketTransport::WebSocketTransport(QObject *parent) : QObject(parent) {}

WebSocketTransport::~WebSocketTransport() { resetSocket(); }

void WebSocketTransport::resetSocket() {
    if (!m_socket) return;
    m_socket->disconnect(this);
    m_socket->deleteLater();
    m_socket = nullptr;
}

void WebSocketTransport::open(const QUrl &url) {
    resetSocket();
    m_url = url;
    m_buffer.clear();
    m_fragment.clear();
    m_handshakeComplete = false;
    m_manualClose = false;
    const bool secure = url.scheme() == QStringLiteral("wss");
    m_socket = secure ? static_cast<QTcpSocket *>(new QSslSocket(this)) : new QTcpSocket(this);
    connect(m_socket, &QTcpSocket::connected, this, &WebSocketTransport::onConnected);
    connect(m_socket, &QTcpSocket::readyRead, this, &WebSocketTransport::onReadyRead);
    connect(m_socket, &QTcpSocket::disconnected, this, &WebSocketTransport::onDisconnected);
    connect(m_socket, &QTcpSocket::errorOccurred, this, &WebSocketTransport::onSocketError);
    const int port = url.port(secure ? 443 : 80);
    if (secure) static_cast<QSslSocket *>(m_socket)->connectToHostEncrypted(url.host(), port);
    else m_socket->connectToHost(url.host(), port);
}

void WebSocketTransport::onConnected() {
    QByteArray nonce(16, 0);
    for (char &byte : nonce) byte = static_cast<char>(QRandomGenerator::global()->generate() & 0xff);
    m_key = nonce.toBase64();
    QString path = m_url.path().isEmpty() ? QStringLiteral("/") : m_url.path();
    if (m_url.hasQuery()) path += QLatin1Char('?') + m_url.query();
    QString host = m_url.host();
    if ((m_url.scheme() == QStringLiteral("ws") && m_url.port() != -1 && m_url.port() != 80)
        || (m_url.scheme() == QStringLiteral("wss") && m_url.port() != -1 && m_url.port() != 443)) {
        host += QLatin1Char(':') + QString::number(m_url.port());
    }
    const QByteArray request = QStringLiteral(
        "GET %1 HTTP/1.1\r\n"
        "Host: %2\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        "Sec-WebSocket-Key: %3\r\n"
        "Sec-WebSocket-Version: 13\r\n\r\n").arg(path, host, m_key).toUtf8();
    m_socket->write(request);
}

void WebSocketTransport::onReadyRead() {
    m_buffer.append(m_socket->readAll());
    if (!m_handshakeComplete) {
        const qint64 headerEnd = m_buffer.indexOf("\r\n\r\n");
        if (headerEnd < 0) {
            if (m_buffer.size() > 65536) m_socket->abort();
            return;
        }
        const QByteArray header = m_buffer.left(headerEnd);
        m_buffer.remove(0, headerEnd + 4);
        const QList<QByteArray> lines = header.split('\n');
        if (lines.isEmpty() || !lines.first().contains(" 101 ")) {
            emit errorOccurred(QStringLiteral("云端 WebSocket 握手失败：%1").arg(QString::fromUtf8(lines.value(0)).trimmed()));
            m_socket->disconnectFromHost();
            return;
        }
        const QByteArray expected = QCryptographicHash::hash(m_key.toUtf8() + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11", QCryptographicHash::Sha1).toBase64();
        QByteArray accept;
        for (const QByteArray &line : lines) {
            if (line.toLower().startsWith("sec-websocket-accept:")) accept = line.mid(line.indexOf(':') + 1).trimmed();
        }
        if (accept != expected) {
            emit errorOccurred(QStringLiteral("云端 WebSocket 证书响应校验失败"));
            m_socket->disconnectFromHost();
            return;
        }
        m_handshakeComplete = true;
        emit connected();
    }
    processFrames();
}

void WebSocketTransport::processFrames() {
    while (m_handshakeComplete && m_socket && m_buffer.size() >= 2) {
        const auto first = static_cast<quint8>(m_buffer.at(0));
        const auto second = static_cast<quint8>(m_buffer.at(1));
        const bool final = first & 0x80;
        const quint8 opcode = first & 0x0f;
        const bool masked = second & 0x80;
        quint64 length = second & 0x7f;
        qint64 offset = 2;
        if (length == 126) {
            if (m_buffer.size() < 4) return;
            length = (static_cast<quint8>(m_buffer.at(2)) << 8) | static_cast<quint8>(m_buffer.at(3));
            offset = 4;
        } else if (length == 127) {
            if (m_buffer.size() < 10) return;
            length = 0;
            for (int i = 0; i < 8; ++i) length = (length << 8) | static_cast<quint8>(m_buffer.at(2 + i));
            offset = 10;
        }
        if (length > MaxFrameSize) {
            emit errorOccurred(QStringLiteral("云端消息超过 24 MiB 限制"));
            m_socket->abort();
            return;
        }
        const qint64 maskSize = masked ? 4 : 0;
        if (m_buffer.size() < offset + maskSize + static_cast<qint64>(length)) return;
        const QByteArray mask = masked ? m_buffer.mid(offset, 4) : QByteArray();
        offset += maskSize;
        QByteArray payload = m_buffer.mid(offset, static_cast<qint64>(length));
        m_buffer.remove(0, offset + static_cast<qint64>(length));
        if (masked) {
            for (qint64 i = 0; i < payload.size(); ++i) payload[i] = payload.at(i) ^ mask.at(i % 4);
        }
        if (opcode == 0x8) {
            sendFrame(0x8, payload);
            m_socket->disconnectFromHost();
            return;
        }
        if (opcode == 0x9) { sendFrame(0xA, payload); continue; }
        if (opcode == 0xA) continue;
        if (opcode == 0x1 || opcode == 0x2) {
            if (final) emit textMessageReceived(QString::fromUtf8(payload));
            else { m_fragment = payload; m_fragmentOpcode = opcode; }
        } else if (opcode == 0x0 && m_fragmentOpcode) {
            m_fragment.append(payload);
            if (m_fragment.size() > MaxFrameSize) { m_socket->abort(); return; }
            if (final) {
                emit textMessageReceived(QString::fromUtf8(m_fragment));
                m_fragment.clear();
                m_fragmentOpcode = 0;
            }
        }
    }
}

bool WebSocketTransport::sendFrame(quint8 opcode, const QByteArray &payload) {
    if (!m_socket || !m_handshakeComplete || m_socket->state() != QAbstractSocket::ConnectedState) return false;
    QByteArray frame;
    frame.append(static_cast<char>(0x80 | opcode));
    const quint64 length = payload.size();
    if (length < 126) frame.append(static_cast<char>(0x80 | length));
    else if (length <= 0xffff) {
        frame.append(static_cast<char>(0x80 | 126));
        frame.append(static_cast<char>((length >> 8) & 0xff));
        frame.append(static_cast<char>(length & 0xff));
    } else {
        frame.append(static_cast<char>(0x80 | 127));
        for (int shift = 56; shift >= 0; shift -= 8) frame.append(static_cast<char>((length >> shift) & 0xff));
    }
    const QByteArray mask = randomMask();
    frame.append(mask);
    QByteArray maskedPayload = payload;
    for (qint64 i = 0; i < maskedPayload.size(); ++i) maskedPayload[i] = maskedPayload.at(i) ^ mask.at(i % 4);
    frame.append(maskedPayload);
    return m_socket->write(frame) == frame.size();
}

bool WebSocketTransport::sendText(const QString &text) {
    return sendFrame(0x1, text.toUtf8());
}

void WebSocketTransport::close() {
    m_manualClose = true;
    if (!m_socket) return;
    if (m_handshakeComplete) {
        QByteArray reason;
        reason.append(static_cast<char>(0x03));
        reason.append(static_cast<char>(0xe8));
        sendFrame(0x8, reason);
    }
    m_socket->disconnectFromHost();
    if (m_socket->state() != QAbstractSocket::UnconnectedState) m_socket->waitForDisconnected(200);
}

void WebSocketTransport::onDisconnected() {
    const QString reason = m_socket ? m_socket->errorString() : QStringLiteral("连接已关闭");
    emit disconnected(m_manualClose ? QStringLiteral("已手动断开") : reason);
}

void WebSocketTransport::onSocketError(QAbstractSocket::SocketError) {
    if (!m_manualClose) emit errorOccurred(m_socket ? m_socket->errorString() : QStringLiteral("网络连接错误"));
}
