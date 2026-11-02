cmake_minimum_required(VERSION 3.21)
project(utoken VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)

find_package(Qt6 REQUIRED COMPONENTS Quick QuickControls2 Network)

qt_add_executable(utoken
    src/main.cpp
    src/AgentController.cpp
    src/AgentController.h
    src/WebSocketTransport.cpp
    src/WebSocketTransport.h
    src/LocalWebServer.cpp
    src/LocalWebServer.h
    src/RemoteAgentController.cpp
    src/RemoteAgentController.h
    src/ServiceControl.cpp
    src/ServiceControl.h
)

qt_add_qml_module(utoken
    URI Umeko.Local
    VERSION 1.0
    QML_FILES qml/Main.qml
)

qt_add_resources(utoken "local-web"
    PREFIX "/"
    FILES web/index.html
)

target_link_libraries(utoken PRIVATE
    Qt6::Quick
    Qt6::QuickControls2
    Qt6::Network
)

install(TARGETS utoken
    BUNDLE DESTINATION .
    RUNTIME DESTINATION bin
)
