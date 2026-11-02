# Umeko Token Relay

将家中自托管的模型服务，安全地变成可分发的 OpenAI 兼容 API。

Umeko Token Relay 由云端中转服务和本地 `utoken` 连接器组成。本地端主动向云端建立 WebSocket/WSS 反向隧道，因此不需要公网 IP、NAT 端口映射或开放家中入站端口。云端统一负责 API Key 分发、计费、额度、限流与并发管理。

[文档站](https://umeiko.github.io/umeko_token_market/) · [快速开始](https://umeiko.github.io/umeko_token_market/start/quick-start.html) · [架构设计](https://umeiko.github.io/umeko_token_market/reference/architecture.html) · [API 参考](https://umeiko.github.io/umeko_token_market/reference/api.html)

## 核心能力

- **反向中转**：普通响应与 SSE 流式响应通过同一条本地出站隧道转发。
- **OpenAI 兼容**：对外提供 `/v1/models` 和 `/v1/*` POST 代理，适配常见 OpenAI SDK。
- **供应商管理**：连接状态、推理健康检查、心跳延迟、模型价格和供应商并发。
- **Key 分发**：独立 API Key、停发、过期时间、Token/费用额度、RPM 与 Key 并发限制。
- **计费与审计**：按模型输入/输出价格入账，提供趋势、Key 结算和可筛选请求日志。
- **三种本地入口**：Docker 风格 CLI、只监听本机的 Web 控制台、Qt 6/QML 附属界面。
- **不管理推理进程**：继续使用你喜欢的 llama.cpp、vLLM 或 SGLang。

## 架构

```text
API 调用方
    │ HTTPS + umo-sk Key
    ▼
云端 Umeko Token Relay
    │ 鉴权、限额、并发控制、计费
    │ 已建立的 WebSocket / WSS 反向隧道
    ▼
本地 utoken 服务
    │ HTTP 127.0.0.1 / 内网地址
    ▼
llama.cpp / vLLM / SGLang
```

云端不会直接连接家中推理端口。Qt/QML 与本地 Web 页面也只是 `utoken` 后台服务的管理前端，不会另建一条供应商连接。

## 快速开始

### 1. 部署云端

要求 Node.js 22.13 或更高版本。

```bash
npm ci --no-bin-links
npm run build
ADMIN_USERNAME=admin ADMIN_PASSWORD='替换为强密码' npm start
```

默认监听 `0.0.0.0:3000`，管理面板与公开 API 共用端口。数据保存在 `data/market.db`。

生产环境请使用 Caddy 或 Nginx 提供 HTTPS/WSS，并持久化 `data` 目录。详细配置见[部署指南](https://umeiko.github.io/umeko_token_market/start/install.html)。

### 2. 启动推理服务

先自行启动 OpenAI 兼容推理服务，并确认本地模型列表可用：

```bash
curl http://127.0.0.1:8080/v1/models
```

### 3. 构建本地 utoken

要求 CMake 3.21、支持 C++17 的编译器，以及 Qt 6 的 Quick、QuickControls2、Network 模块。

```bash
cmake -S local-app -B local-app/build -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build local-app/build
```

可将 `local-app/build/utoken` 复制到 `PATH` 中。

### 4. 创建供应商并连接

在云端管理面板的“供应商与模型”中创建供应商，配置模型名称、每百万 Token 的输入/输出美元价格和最大并发。保存后复制一次性连接命令：

```bash
utoken up \
  --cloud-url https://api.example.com \
  --provider-id 1 \
  --provider-token 'umo-agent-...' \
  --local-base-url http://127.0.0.1:8080
```

`utoken up` 在后台启动并立即返回。本地 Web 控制台默认位于 `http://127.0.0.1:8787`。

### 5. 分发 API Key 并调用

在云端“API Key”页面为调用方创建独立 Key：

```bash
curl https://api.example.com/v1/chat/completions \
  -H 'Authorization: Bearer umo-sk-...' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "your-model-name",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": true
  }'
```

## 本地服务命令

| 命令 | 作用 |
| --- | --- |
| `utoken up` | 启动后台服务，或恢复已停止的转发 |
| `utoken status` / `utoken ps` | 查看云端、推理和请求状态 |
| `utoken logs` | 输出当前服务的最近 200 条日志 |
| `utoken stop` | 停止转发，保留本机管理服务 |
| `utoken down` | 停止并退出后台服务 |
| `utoken ui` | 打开 Qt/QML 附属界面 |
| `utoken web` | 输出本机 Web 控制台地址 |
| `utoken serve` | 前台运行核心服务，适合 systemd 托管 |

`--web-port` 可修改默认管理端口。`utoken serve --no-web` 可关闭本机 Web/API，但此时不能使用 `status`、`stop` 或 QML 远程控制。

## 项目结构

```text
server/                 云端 Fastify 服务、SQLite、鉴权、计费与隧道
src/                    云端 Vue 管理面板
local-app/
  src/AgentController   本地连接、健康检查与流式转发核心
  src/LocalWebServer    仅监听 127.0.0.1 的 Web/API
  src/RemoteAgentController  QML 到 CLI 服务的远程控制适配
  qml/                  Qt/QML 桌面界面
  web/                  本地 Web 控制台
  CMakeLists.txt        utoken 构建配置
agent/                  可选的 Node.js 命令行连接器
docs-site/              VitePress 文档站
.github/workflows/      GitHub Pages 部署
```

## 安全说明

- API Key 和供应商凭据在云端只保存 SHA-256 哈希，完整凭据仅创建时显示一次。
- 管理员密码使用 scrypt 哈希，管理会话使用 HttpOnly、SameSite=Strict Cookie。
- 本地管理 API 只绑定 `127.0.0.1` 并校验 Host，不应对外映射。
- 公网部署必须启用 HTTPS/WSS；否则 API Key、供应商凭据和模型内容可能被窃听。
- 本地 QSettings 会保存连接配置，请使用操作系统账户权限保护用户目录。
- 云端当前按单进程设计，不要直接启动多个进程共享同一数据库做水平扩展。

## 文档

- [快速开始](https://umeiko.github.io/umeko_token_market/start/quick-start.html)
- [云端部署](https://umeiko.github.io/umeko_token_market/start/install.html)
- [本地 CLI、Web 与 QML](https://umeiko.github.io/umeko_token_market/guide/local.html)
- [架构设计](https://umeiko.github.io/umeko_token_market/reference/architecture.html)
- [API 接口参考](https://umeiko.github.io/umeko_token_market/reference/api.html)
- [反向隧道协议](https://umeiko.github.io/umeko_token_market/reference/tunnel.html)
- [安全与生产检查](https://umeiko.github.io/umeko_token_market/guide/security.html)

## License

项目当前未声明开源许可证。分发或修改前请先与仓库所有者确认。
