#include "AgentController.h"
#include "LocalWebServer.h"
#include "RemoteAgentController.h"
#include "ServiceControl.h"

#include <QCommandLineOption>
#include <QCommandLineParser>
#include <QCoreApplication>
#include <QDebug>
#include <QFileInfo>
#include <QGuiApplication>
#include <QJsonArray>
#include <QProcess>
#include <QQmlApplicationEngine>
#include <QQmlContext>
#include <QQuickStyle>
#include <QTextStream>
#include <QThread>
#include <QTimer>

struct Options {
    QCommandLineOption cloud{QStringList() << QStringLiteral("cloud-url"), QStringLiteral("Cloud base URL"), QStringLiteral("url")};
    QCommandLineOption provider{QStringList() << QStringLiteral("provider-id"), QStringLiteral("Provider ID"), QStringLiteral("id")};
    QCommandLineOption token{QStringList() << QStringLiteral("provider-token"), QStringLiteral("Provider token"), QStringLiteral("token")};
    QCommandLineOption local{QStringList() << QStringLiteral("local-base-url"), QStringLiteral("Local inference base URL"), QStringLiteral("url")};
    QCommandLineOption localKey{QStringList() << QStringLiteral("local-api-key"), QStringLiteral("Local inference API key"), QStringLiteral("key")};
    QCommandLineOption automatic{QStringList() << QStringLiteral("auto-start"), QStringLiteral("Connect immediately")};
};

void addConnectionOptions(QCommandLineParser &parser, Options &options) {
    parser.addOptions({options.cloud, options.provider, options.token, options.local, options.localKey, options.automatic});
}

void configureAgent(const QCommandLineParser &parser, const Options &options, AgentController &agent) {
    if (parser.isSet(options.cloud)) agent.setCloudUrl(parser.value(options.cloud));
    if (parser.isSet(options.provider)) agent.setProviderId(parser.value(options.provider).toInt());
    if (parser.isSet(options.token)) agent.setProviderToken(parser.value(options.token));
    if (parser.isSet(options.local)) agent.setLocalBaseUrl(parser.value(options.local));
    if (parser.isSet(options.localKey)) agent.setLocalApiKey(parser.value(options.localKey));
    if (parser.isSet(options.automatic) || (agent.autoConnect() && !agent.providerToken().isEmpty())) {
        QTimer::singleShot(0, &agent, &AgentController::start);
    }
}

void setMetadata() {
    QCoreApplication::setOrganizationName(QStringLiteral("Umeko"));
    QCoreApplication::setApplicationName(QStringLiteral("utoken"));
    QCoreApplication::setApplicationVersion(QStringLiteral("1.0.0"));
}

int runService(int argc, char *argv[]) {
    QCoreApplication app(argc, argv);
    setMetadata();
    QCommandLineParser parser;
    Options options;
    parser.setApplicationDescription(QStringLiteral("utoken serve · run the Umeko connector in the foreground"));
    parser.addHelpOption(); parser.addVersionOption();
    parser.addPositionalArgument(QStringLiteral("serve"), QStringLiteral("Service command"));
    addConnectionOptions(parser, options);
    QCommandLineOption webPort(QStringList() << QStringLiteral("web-port"), QStringLiteral("Local management port"), QStringLiteral("port"), QStringLiteral("8787"));
    QCommandLineOption noWeb(QStringList() << QStringLiteral("no-web"), QStringLiteral("Disable the local management API"));
    parser.addOptions({webPort, noWeb});
    parser.process(app);

    AgentController agent;
    configureAgent(parser, options, agent);
    QObject::connect(&agent, &AgentController::logsChanged, &app, [&agent] {
        if (!agent.logs().isEmpty()) qInfo().noquote() << agent.logs().constLast();
    });
    LocalWebServer web(&agent);
    QObject::connect(&web, &LocalWebServer::shutdownRequested, &app, [&app] { QTimer::singleShot(200, &app, &QCoreApplication::quit); });
    if (!parser.isSet(noWeb)) {
        bool ok = false;
        const quint16 port = parser.value(webPort).toUShort(&ok);
        if (!ok || !web.listen(port)) {
            qCritical().noquote() << "Unable to bind the local management port. Choose another --web-port.";
            return 2;
        }
        qInfo().noquote() << QStringLiteral("Umeko Web console: http://127.0.0.1:%1").arg(web.port());
    }
    qInfo().noquote() << "Umeko connector is running in the foreground. Press Ctrl+C to stop.";
    return QCoreApplication::exec();
}

QString executablePath(char *argv0) { return QFileInfo(QString::fromLocal8Bit(argv0)).absoluteFilePath(); }

bool launchService(char *argv0, const QCommandLineParser &parser, const Options &options, const QString &port) {
    QStringList arguments{QStringLiteral("serve"), QStringLiteral("--auto-start"), QStringLiteral("--web-port"), port};
    const QList<QPair<QCommandLineOption, QString>> forwarded = {
        {options.cloud, parser.value(options.cloud)}, {options.provider, parser.value(options.provider)},
        {options.token, parser.value(options.token)}, {options.local, parser.value(options.local)},
        {options.localKey, parser.value(options.localKey)},
    };
    for (const auto &entry : forwarded) {
        if (!entry.second.isEmpty()) arguments << QStringLiteral("--") + entry.first.names().constFirst() << entry.second;
    }
    QProcess process;
    process.setProgram(executablePath(argv0));
    process.setArguments(arguments);
    process.setStandardInputFile(QProcess::nullDevice());
    process.setStandardOutputFile(QProcess::nullDevice());
    process.setStandardErrorFile(QProcess::nullDevice());
    return process.startDetached();
}

int runCommand(int argc, char *argv[]) {
    QCoreApplication app(argc, argv);
    setMetadata();
    QCommandLineParser parser;
    Options options;
    parser.setApplicationDescription(QStringLiteral("utoken · Umeko local connector\n\nCommands: up, down, stop, status, ps, logs, ui, serve"));
    parser.addHelpOption(); parser.addVersionOption();
    parser.addPositionalArgument(QStringLiteral("command"), QStringLiteral("up, down, stop, status, ps, logs, ui or serve"));
    addConnectionOptions(parser, options);
    QCommandLineOption webPort(QStringList() << QStringLiteral("web-port"), QStringLiteral("Local management port"), QStringLiteral("port"), QStringLiteral("8787"));
    parser.addOption(webPort);
    parser.process(app);
    const QString command = parser.positionalArguments().value(0);
    const quint16 port = parser.value(webPort).toUShort();
    QTextStream out(stdout);
    QTextStream err(stderr);

    if (command == QStringLiteral("up")) {
        if (ServiceControl::running(port)) {
            QJsonObject config;
            if (parser.isSet(options.cloud)) config.insert(QStringLiteral("cloudUrl"), parser.value(options.cloud));
            if (parser.isSet(options.provider)) config.insert(QStringLiteral("providerId"), parser.value(options.provider).toInt());
            if (parser.isSet(options.token)) config.insert(QStringLiteral("providerToken"), parser.value(options.token));
            if (parser.isSet(options.local)) config.insert(QStringLiteral("localBaseUrl"), parser.value(options.local));
            if (parser.isSet(options.localKey)) config.insert(QStringLiteral("localApiKey"), parser.value(options.localKey));
            bool ok = false;
            ServiceControl::request(QStringLiteral("POST"), QStringLiteral("/api/start"), port, config, &ok);
            if (!ok) { err << "Failed to resume provider forwarding.\n"; return 1; }
            out << "Umeko service is running; provider forwarding started.\n";
            return 0;
        }
        if (!launchService(argv[0], parser, options, QString::number(port))) { err << "Failed to start the Umeko service.\n"; return 1; }
        for (int i = 0; i < 30; ++i) {
            QThread::msleep(100);
            if (ServiceControl::running(port)) {
                out << "Umeko service is up.\nWeb console: http://127.0.0.1:" << port << "\n";
                return 0;
            }
        }
        err << "The service did not become ready. Run 'utoken serve' to inspect startup errors.\n";
        return 1;
    }
    if (command == QStringLiteral("status") || command == QStringLiteral("ps")) {
        bool ok = false;
        const QJsonObject status = ServiceControl::request(QStringLiteral("GET"), QStringLiteral("/api/status"), port, {}, &ok);
        if (!ok) { out << "Umeko service is not running.\n"; return 3; }
        out << "Umeko service is running\n"
            << "Cloud: " << status.value(QStringLiteral("connectionState")).toString() << "\n"
            << "Provider: " << status.value(QStringLiteral("providerName")).toString(QStringLiteral("not authenticated")) << "\n"
            << "Local inference: " << (status.value(QStringLiteral("localOnline")).toBool() ? "online" : "offline") << "\n"
            << "Requests: " << status.value(QStringLiteral("activeRequests")).toInt() << " active / "
            << status.value(QStringLiteral("totalRequests")).toInt() << " total\n";
        return 0;
    }
    if (command == QStringLiteral("logs")) {
        bool ok = false;
        const QJsonObject status = ServiceControl::request(QStringLiteral("GET"), QStringLiteral("/api/status"), port, {}, &ok);
        if (!ok) { err << "Umeko service is not running.\n"; return 3; }
        const QJsonArray logs = status.value(QStringLiteral("logs")).toArray();
        for (const auto &line : logs) out << line.toString() << "\n";
        return 0;
    }
    if (command == QStringLiteral("stop") || command == QStringLiteral("down")) {
        const QString path = command == QStringLiteral("down") ? QStringLiteral("/api/shutdown") : QStringLiteral("/api/stop");
        bool ok = false;
        ServiceControl::request(QStringLiteral("POST"), path, port, {}, &ok);
        if (!ok) { err << "Umeko service is not running.\n"; return 3; }
        out << (command == QStringLiteral("down") ? "Umeko service stopped.\n" : "Provider forwarding stopped; management service is still running.\n");
        return 0;
    }
    if (command == QStringLiteral("web")) {
        out << "Web console: http://127.0.0.1:" << port << "\n";
        return ServiceControl::running(port) ? 0 : 3;
    }
    parser.showHelp(command.isEmpty() ? 0 : 1);
}

int runGui(int argc, char *argv[]) {
    QGuiApplication app(argc, argv);
    setMetadata();
    QQuickStyle::setStyle(QStringLiteral("Basic"));
    QCommandLineParser parser;
    parser.setApplicationDescription(QStringLiteral("Umeko Qt/QML companion for the utoken service"));
    parser.addHelpOption(); parser.addVersionOption();
    QCommandLineOption gui(QStringList() << QStringLiteral("gui"), QStringLiteral("Start the desktop companion"));
    QCommandLineOption webPort(QStringList() << QStringLiteral("web-port"), QStringLiteral("utoken management port"), QStringLiteral("port"), QStringLiteral("8787"));
    parser.addOptions({gui, webPort});
    parser.process(app);
    RemoteAgentController agent(parser.value(webPort).toUShort());
    QQmlApplicationEngine engine;
    engine.rootContext()->setContextProperty(QStringLiteral("agent"), &agent);
    QObject::connect(&engine, &QQmlApplicationEngine::objectCreationFailed, &app, [] { QCoreApplication::exit(-1); }, Qt::QueuedConnection);
    engine.loadFromModule("Umeko.Local", "Main");
    return QGuiApplication::exec();
}

int main(int argc, char *argv[]) {
    const QString command = argc > 1 ? QString::fromLocal8Bit(argv[1]) : QString();
    if (command == QStringLiteral("serve")) return runService(argc, argv);
    if (command == QStringLiteral("--gui")) return runGui(argc, argv);
    if (command == QStringLiteral("ui")) {
        QCoreApplication app(argc, argv);
        QStringList arguments{QStringLiteral("--gui")};
        for (int i = 2; i < argc; ++i) arguments << QString::fromLocal8Bit(argv[i]);
        return QProcess::startDetached(executablePath(argv[0]), arguments) ? 0 : 1;
    }
    return runCommand(argc, argv);
}
