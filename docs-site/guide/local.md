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

1. 在云端「供应商与模型」添加 **本地 API 隧道** 或 **本地视频隧道**。点击「创建并生成配对链接」，复制链接。
2. 在本机 utoken 控制台左侧新建模型，选择「文本生成」或「视频生成」，粘贴配对链接并填写本地服务地址和 API Key。以 H3 为例，服务地址填写 `http://127.0.0.1:8792`，健康检查填写 `/health`，Key 使用 H3 服务发放的调用 Key。
3. 点击「配对并连接」。链接会配置云端地址、供应商 ID、连接凭据和服务类型。链接 10 分钟内可用一次。在云端供应商卡片点「配对链接」可生成新的链接。
4. 连接后，utoken 自动探测并上报模型。云端「本机上报」显示模型名称、健康检查路径和本地服务是否配置了 Key。可从上报列表选择模型，配置对外别名和价格，再授权调用方的 Relay API Key。已有 CLI 工作流也可在本地「手动配置云端」中配置。

本地 Web 只绑定回环地址，管理响应不返回已保存的密钥。启用「启动 utoken 时自动连接」后，运行连接器时会恢复连接。若需开机启动，由 systemd 或系统启动项负责启动连接器本身。

一个 Web 控制台可以管理多个模型。各模型保存独立的本地服务地址、Key 和云端供应商配对。删除模型会断开该模型的转发并移除本地配置。CLI 仍可使用独立配置名和管理端口启动实例：

```bash
utoken up --profile chat --web-port 8787
utoken up --profile video --web-port 8788
```

Linux 可以用用户级 systemd 管理后台连接器。把 `utoken` 安装到 `~/.local/bin`，将项目的 `local-app/systemd/` 中两个 unit 安装到 `~/.config/systemd/user/`。默认连接器用 `systemctl --user enable --now utoken.service` 启动，界面端口为 8787。命名配置在 `~/.config/utoken/<配置名>.env` 中填写独立的 `UTOKEN_WEB_PORT`，再启用 `utoken@<配置名>.service`。启用账户的 systemd linger 后，连接器可以在开机时启动。

分别打开 `http://127.0.0.1:8787` 和 `http://127.0.0.1:8788` 完成配置。操作指定实例时带上对应的 `--web-port`。视频节点使用 [本地视频服务协议](../reference/video.md#本地视频隧道)。

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
