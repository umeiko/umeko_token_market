# API 接口参考

云端默认基础地址为 `https://api.example.com`。公开模型 API 使用 `Authorization: Bearer umo-sk-...`；管理 API 使用登录后写入的 HttpOnly Cookie。

## 通用错误

公开模型 API 使用 OpenAI 风格错误：

```json
{
  "error": {
    "message": "API Key 的 Token 额度已用尽",
    "type": "rate_limit_error"
  }
}
```

管理 API 通常返回：

```json
{ "error": "错误说明" }
```

常见状态码：`400` 参数错误、`401` 未认证或 Key 无效、`429` 限流/额度/并发、`503` 无可用供应商、`504` 本地响应超时。

## 健康与公开模型 API

### GET /health

无需认证，用于云端存活检查。

```json
{ "status": "ok", "providers_online": 1 }
```

### GET /v1/models

需要 API Key。只返回当前在线、健康且启用模型。响应符合 OpenAI 模型列表结构：

```json
{
  "object": "list",
  "data": [
    { "id": "qwen3-32b", "object": "model", "created": 0, "owned_by": "umeko-relay" }
  ]
}
```

模型列表请求也参与 Key 的额度和 RPM 检查，但不写入推理用量日志。

### POST /v1/*

需要 API Key。`chat/completions`、`completions`、`embeddings` 等路径按原路径转发到本地 OpenAI 兼容服务，请求体必须为 JSON 对象并包含 `model`。

```http
POST /v1/chat/completions
Authorization: Bearer umo-sk-...
Content-Type: application/json
```

```json
{
  "model": "qwen3-32b",
  "messages": [{"role": "user", "content": "你好"}],
  "stream": true
}
```

云端对聊天流式请求补充 `stream_options.include_usage=true`。响应状态、非 hop-by-hop 响应头和正文来自上游，额外返回 `x-request-id`。

## 管理员认证

### POST /api/admin/login

```json
{ "username": "admin", "password": "your-password" }
```

成功返回管理员并写入 `umeko_session` Cookie。Cookie 为 HttpOnly、SameSite=Strict，有效期 7 天；`COOKIE_SECURE=true` 时仅通过 HTTPS 发送。每个 IP 在 10 分钟内最多失败尝试 10 次。

### POST /api/admin/logout

删除当前会话并清除 Cookie。

### GET /api/admin/me

返回当前用户：

```json
{ "user": { "id": 1, "username": "admin" } }
```

除登录和退出外，以下管理接口均要求有效会话。

## 概览与统计

### GET /api/admin/overview

返回 `today`、`totals`、14 天 `series` 和最近 8 条 `recent`。金额字段 `cost` 为美元，原始数据库字段 `cost_micros` 为百万分之一美元。

### GET /api/admin/usage

查询参数：

| 参数 | 说明 |
| --- | --- |
| `page` | 页码，从 1 开始，默认 1 |
| `key_id` | 可选 Key ID |
| `provider_id` | 可选供应商 ID |
| `status` | `success` 或 `error` |

每页 30 条，返回 `logs`、`total`、`page`、`pages`。

## 供应商管理

### GET /api/admin/providers

返回供应商、连接/健康状态、活动并发及每个供应商的模型列表。不返回完整连接凭据。

### POST /api/admin/providers

```json
{
  "name": "家中 4090 工作站",
  "description": "可选描述",
  "max_concurrency": 4,
  "models": [
    { "name": "qwen3-32b", "input_price": 2, "output_price": 6 }
  ]
}
```

至少一个模型。成功返回：

```json
{ "id": 1, "token": "umo-agent-..." }
```

完整 token 只在此次响应出现。

### PATCH /api/admin/providers/:id

可更新 `name`、`description`、`max_concurrency`、`enabled`。停用会关闭当前隧道。

### POST /api/admin/providers/:id/rotate

轮换连接凭据并断开旧连接，返回新 `token`。

### POST /api/admin/providers/:id/models

```json
{ "name": "new-model", "input_price": 1, "output_price": 3 }
```

同一供应商下模型名唯一。

### PATCH /api/admin/models/:id

可更新 `name`、`input_price`、`output_price`、`enabled`。

### DELETE /api/admin/models/:id

删除模型映射，不删除已有请求日志。

## API Key 管理

### GET /api/admin/keys

返回 Key 列表、累计用量、当前并发和额度，不返回 Key 哈希或完整明文。

### POST /api/admin/keys

```json
{
  "name": "Alice 的应用",
  "token_quota": 1000000,
  "budget_quota": 10,
  "rpm_limit": 60,
  "concurrency_limit": 2,
  "expires_at": "2027-01-01T00:00"
}
```

额度为 `0` 表示不限制，`expires_at` 可省略或为 `null`。成功返回：

```json
{ "id": 1, "key": "umo-sk-..." }
```

### PATCH /api/admin/keys/:id

支持创建时的字段以及：

- `enabled`：启用或停发；
- `expires_at`：修改或清空过期时间；
- `reset_usage: true`：累计 Token 和费用清零。

## 设置与密码

### GET /api/admin/settings

返回 `site_name` 和 `request_timeout_ms`。

### PATCH /api/admin/settings

```json
{ "site_name": "Umeko Token Relay", "request_timeout_ms": 300000 }
```

超时范围为 5,000 到 1,800,000 毫秒。

### POST /api/admin/password

```json
{ "current_password": "old-password", "new_password": "new-password" }
```

新密码至少 10 个字符。当前密码错误时返回 `{ "ok": false, "error": "当前密码错误" }`。

## 本地 Web 管理 API

默认基础地址为 `http://127.0.0.1:8787`，仅允许回环 Host。它不是云端管理 API，不要暴露到公网。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/status` | 云端状态、推理健康、请求数与最近日志 |
| GET | `/api/config` | 当前本地连接配置 |
| POST | `/api/config` | 保存配置但不启动转发 |
| POST | `/api/start` | 应用 JSON 配置并启动转发 |
| POST | `/api/stop` | 停止转发，保留管理服务 |
| POST | `/api/check` | 探测本地 `/v1/models` |
| POST | `/api/clear-logs` | 清空当前内存日志 |
| POST | `/api/shutdown` | 停止转发并退出后台服务 |

配置 JSON 字段：

```json
{
  "cloudUrl": "https://api.example.com",
  "providerId": 1,
  "providerToken": "umo-agent-...",
  "localBaseUrl": "http://127.0.0.1:8080",
  "localApiKey": "",
  "autoConnect": true
}
```

`status` 示例：

```json
{
  "connectionState": "online",
  "providerName": "家中工作站",
  "localOnline": true,
  "localLatency": 3,
  "activeRequests": 1,
  "totalRequests": 42,
  "logs": ["12:00:00  云端通道已建立，正在验证供应商凭据"]
}
```
