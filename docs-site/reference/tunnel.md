# 反向隧道协议

隧道是云端与本地连接器之间的应用层 JSON 消息协议，承载于单个 WebSocket/WSS 连接。它不等同于公开 OpenAI API，也不向调用方开放。

## 连接与认证

本地连接：

```text
GET /agent/connect HTTP/1.1
Upgrade: websocket
Connection: Upgrade
```

建立 socket 后，本地必须在 10 秒内发送第一条认证消息：

```json
{
  "type": "auth",
  "providerId": 1,
  "token": "umo-agent-..."
}
```

云端按供应商 ID 和 token 的 SHA-256 哈希验证，并要求供应商启用。成功：

```json
{ "type": "auth_ok", "provider": "家中工作站" }
```

失败、超时或停用会关闭连接。同一供应商建立新连接时，旧连接被替换。

生产环境必须使用 `wss://`，避免凭据和模型内容被窃听。

## 健康上报

本地每 15 秒请求一次 `LOCAL_BASE_URL/v1/models`，并上报：

```json
{
  "type": "health",
  "online": true,
  "latency": 3,
  "message": ""
}
```

失败时 `online=false`，`message` 包含 HTTP 状态或连接错误。云端只有在线且健康的供应商参与调度。

此外，云端每 15 秒发送 WebSocket ping，本地必须按协议回复 pong，用于检测无响应连接。

## 云端请求消息

```json
{
  "type": "request",
  "id": "请求UUID",
  "method": "POST",
  "path": "/v1/chat/completions",
  "headers": {
    "content-type": "application/json",
    "accept": "application/json, text/event-stream"
  },
  "body": "Base64编码的JSON请求体"
}
```

`id` 关联整个请求生命周期。本地使用给定 method/path/body 请求推理服务；如果配置了本地 API Key，会替换为本地自己的 Authorization，不转发调用方的 `umo-sk` Key。

## 本地响应消息

### response

响应头可用时首先发送：

```json
{
  "type": "response",
  "id": "请求UUID",
  "status": 200,
  "headers": { "content-type": "text/event-stream" }
}
```

不转发 `content-length`、`content-encoding`、`transfer-encoding`、`connection` 等逐跳或不适用头。

### chunk

每个网络分块独立 Base64 编码：

```json
{ "type": "chunk", "id": "请求UUID", "data": "Base64..." }
```

云端收到后立即写入 HTTP 响应，不等待完整生成。

### end

```json
{ "type": "end", "id": "请求UUID" }
```

表示正常结束。云端结束响应流、观察 usage、写入账单并释放并发。

### error

```json
{ "type": "error", "id": "请求UUID", "message": "本地转发失败：..." }
```

响应头尚未返回时，云端向调用方返回网关错误；流式响应中途失败时终止当前流并记录错误。

## 取消

云端检测到调用方断开或取消时发送：

```json
{ "type": "cancel", "id": "请求UUID" }
```

本地中止对应 QNetworkReply。超时、供应商 socket 断开和云端关闭也会终止待处理请求。

## 重连与限制

- 本地断线后从 1 秒开始指数退避，最大 30 秒；
- WebSocket 应用消息和帧限制为 24 MiB；
- 云端 HTTP JSON body 限制为 20 MiB；
- 请求超时默认 300 秒，可在云端设置中调整；
- 协议不是可靠消息队列，断线时正在执行的请求失败，不自动重放。

## 版本演进建议

新增消息字段应保持向后兼容。需要引入压缩、双向多路优先级或持久重放时，应增加显式协议版本协商，而不是改变现有 `type` 的隐含语义。
