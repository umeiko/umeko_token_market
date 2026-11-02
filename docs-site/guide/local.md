# 本地 CLI、Web 与 QML

`utoken` 是本地唯一运行转发逻辑的核心。CLI、Web 和 Qt/QML 不是三套独立代理：后两者通过本机管理 API 控制同一个后台服务。

## 反向连接模型

本地服务主动向云端 `/agent/connect` 建立 WebSocket/WSS。外部调用方只连接云端，云端不会连接你家的 IP 或推理端口。

```text
utoken serve / 后台服务
  ├─ 出站 WebSocket/WSS → 云端
  ├─ HTTP → 本机或内网推理服务
  └─ 127.0.0.1:8787 → 本地 Web / QML / CLI 控制
```

## 后台服务

```bash
utoken up \
  --cloud-url https://api.example.com \
  --provider-id 1 \
  --provider-token 'umo-agent-...' \
  --local-base-url http://127.0.0.1:8080
```

`up` 会分离后台进程并立即返回，标准输入、输出和错误重定向到空设备。服务日志仍可通过 `utoken logs`、Web 或 QML 查看。

再次执行 `up` 时，如果管理服务已经运行，它会恢复转发；同时传入配置参数则会先更新配置。

## 停止与退出

| 命令 | 转发核心 | 本机管理 API |
| --- | --- | --- |
| `utoken stop` | 停止 | 继续运行 |
| `utoken up` | 恢复 | 继续运行 |
| `utoken down` | 停止 | 退出 |

## 本机 Web 控制台

默认地址为 `http://127.0.0.1:8787`。修改端口：

```bash
utoken up --web-port 8890
```

Web 页面提供连接配置、健康状态、活动/累计请求和最近日志。API 只绑定回环地址并校验 Host，不应通过端口映射或反向代理暴露到局域网/公网。

## Qt/QML 附属界面

```bash
utoken ui
```

如果管理服务使用其他端口：

```bash
utoken ui --web-port 8890
```

QML 每 1.5 秒同步一次状态。启动 QML 前应先运行 `utoken up`。它不会自行创建第二条供应商隧道。

## systemd 前台服务

`utoken serve` 不分离进程，适合服务管理器：

```ini
[Unit]
Description=Umeko Token Relay local connector
After=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/utoken serve --auto-start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

配置保存在执行服务的用户 QSettings 中。可先通过 Web/QML 配置，再让 systemd 使用同一个用户运行。

## 本地推理鉴权

如果 llama.cpp、vLLM 或网关需要 Key：

```bash
utoken up --local-api-key '本地推理Key'
```

它与云端供应商凭据、调用方 `umo-sk` Key 是三种不同凭据，不要混用。
