# utoken 命令参考

## 总览

```text
utoken [options] command
```

主要命令：`up`、`down`、`stop`、`status`、`ps`、`logs`、`ui`、`web`、`serve`。

## utoken up

后台启动本机管理服务并立即返回。如果管理服务已存在，则恢复转发。

```bash
utoken up [连接参数] [--web-port 8787]
```

| 参数 | 说明 |
| --- | --- |
| `--cloud-url <url>` | 云端基础地址，HTTP/HTTPS 自动映射为 WS/WSS |
| `--provider-id <id>` | 云端供应商 ID |
| `--provider-token <token>` | `umo-agent-...` 连接凭据 |
| `--local-base-url <url>` | 本地推理基础地址，不包含 `/v1/models` |
| `--local-api-key <key>` | 可选本地推理 Key |
| `--web-port <port>` | 本机 Web/管理 API 端口，默认 8787 |

示例：

```bash
utoken up --cloud-url https://api.example.com --provider-id 1 \
  --provider-token 'umo-agent-...' --local-base-url http://127.0.0.1:8080
```

## utoken status / ps

```bash
utoken status [--web-port 8787]
```

输出管理服务、云端连接、供应商、本地推理和活动/累计请求。服务未运行时退出码为 `3`。

## utoken logs

输出当前后台服务内存中的最近 200 条事件。后台服务重启后日志清零；持久运行日志建议由 systemd 等管理器收集。

## utoken stop

断开供应商并停止转发，保留 `127.0.0.1` 管理 API。再次执行 `utoken up` 恢复。

## utoken down

停止转发并退出后台管理服务。Web、QML 和状态命令随后不可用。

## utoken ui

分离启动 Qt/QML 管理界面并立即返回：

```bash
utoken ui [--web-port 8787]
```

QML 连接到已经运行的管理服务，不启动独立转发核心。

## utoken web

输出本机 Web 控制台地址。服务未运行时退出码为 `3`。

## utoken serve

前台运行核心，适合 systemd、容器或调试：

```bash
utoken serve [连接参数] [--auto-start] [--web-port 8787]
```

- `--auto-start`：启动后立即连接供应商；没有该参数时可稍后在 Web/QML 中启动。
- `--no-web`：关闭本机 Web/管理 API。此模式下无法使用 `status`、`stop` 或 QML 远程控制。
- 如果 QSettings 已启用“启动应用后自动连接”且存在供应商凭据，也会自动启动。

## 退出码

| 退出码 | 含义 |
| --- | --- |
| `0` | 命令成功 |
| `1` | 启动、恢复或命令参数失败 |
| `2` | 前台服务无法绑定管理端口 |
| `3` | 管理服务未运行或不可访问 |
