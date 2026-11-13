# API 接口参考

云端默认基础地址为 `https://api.example.com`。公开模型 API 使用 `Authorization: Bearer umo-sk-...`；管理 API 使用登录后写入的 HttpOnly Cookie。

如果配置了 `BASE_PATH=/api_seller`，则以下云端路径都增加该前缀，例如 `/api_seller/v1/models` 和 `/api_seller/api/admin/login`；本地 Web 管理 API 不使用该前缀。

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

### POST /v1/messages（Anthropic）

同时提供 Anthropic Messages 兼容入口。使用 `x-api-key: umo-sk-...` 或 Bearer Key，建议携带 `anthropic-version: 2023-06-01`。

```json
{
  "model": "qwen3-32b",
  "max_tokens": 1024,
  "system": "You are concise.",
  "messages": [
    { "role": "user", "content": [{"type": "text", "text": "你好"}] }
  ],
  "stream": false
}
```

支持 system、user/assistant 消息、text/base64 image 内容块、max_tokens、temperature、top_p、stop_sequences 与 stream。工具调用内容块暂未转换，应改用 OpenAI 接口。

普通响应转换为 Anthropic `message` JSON，流式响应依次产生 `message_start`、`content_block_start`、`content_block_delta`、`content_block_stop`、`message_delta` 和 `message_stop`。错误使用 `{ "type": "error", "error": { "type": "...", "message": "..." } }`。

## 管理员认证

### POST /api/admin/login

```json
{ "username": "admin", "password": "your-password" }
```

成功返回管理员并写入 `umeko_session` Cookie。Cookie 为 HttpOnly、SameSite=Strict，有效期 7 天；`COOKIE_SECURE=true` 时仅通过 HTTPS 发送。每个 IP 在 10 分钟内最多失败尝试 10 次。

### POST /api/admin/ssh/challenge

```json
{ "publicKey": "ssh-ed25519 AAAA..." }
```

已授权公钥可获取 5 分钟随机挑战。使用 `ssh-keygen -Y sign -f ~/.ssh/id_ed25519 -n umeko-admin challenge-file` 签名后，将挑战 ID、公钥和 `.sig` 文件的 Base64 提交到 `/api/admin/ssh/login`。成功后写入同一管理员 Cookie。

### GET /api/admin/ssh-keys · POST /api/admin/ssh-keys · DELETE /api/admin/ssh-keys/:id

仅管理员会话可用，用于列出、授权和移除 Token Seller 管理员的 OpenSSH 公钥。私钥和签名私钥不会上传。

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

云端直连示例：

```json
{
  "name": "OpenAI 主账号",
  "provider_type": "openai",
  "base_url": "https://api.openai.com",
  "api_key": "sk-...",
  "client_mode": "regex",
  "client_pattern": "^Umeko/0\\.7\\.2$",
  "client_error_field": "vendor_message",
  "client_error_code": "upgrade_client",
  "client_error_message": "请升级 Umeko 客户端",
  "models": [
    { "name": "fast", "upstream_name": "gpt-4.1-mini", "input_price": 1, "output_price": 2 }
  ]
}
```

`provider_type` 支持 `tunnel`、`openai`、`anthropic`。`upstream_name` 是发送给上游的真实模型，`name` 是对外别名。客户端校验可使用 `regex` 或带 `*` 的 `template`。

### PATCH /api/admin/providers/:id

可更新连接信息、上游 API Key、`max_concurrency`、`enabled` 和客户端校验配置。留空 `api_key` 会保留现有密钥。停用会关闭当前隧道。

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
  "quota_5h": 2000000,
  "quota_week": 20000000,
  "allow_user_apply": true,
  "rpm_limit": 60,
  "concurrency_limit": 2,
  "expires_at": "2027-01-01T00:00"
}
```

`quota_5h` 和 `quota_week` 按当前 Key 的滚动窗口日志限制。`allow_user_apply=true` 时，注册用户可按该策略申请自己的新 Key，不会获得原始 Key。额度为 `0` 表示不限制，`expires_at` 可省略或为 `null`。成功返回：

```json
{ "id": 1, "key": "umo-sk-..." }
```

### PATCH /api/admin/keys/:id

支持创建时的字段以及：

- `enabled`：启用或停发；
- `expires_at`：修改或清空过期时间；
- `reset_usage: true`：累计 Token 和费用清零，并重置五小时/周起算点，历史日志保留。

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

## 注册用户与自助门户

用户入口为 `/portal`。用户认证使用独立 `utoken_user_session` Cookie，不使用管理员会话。

### GET /api/user/config

返回 Turnstile site key、是否开发邮件模式，以及默认五小时和周额度。

### POST /api/user/code

```json
{ "email": "user@example.com", "turnstile_token": "可选，配置 Turnstile 后必填" }
```

发送 6 位验证码。新邮箱验证后自动注册。接口执行 IP/邮箱发送频率、IP 注册次数、一次性邮箱和蜜罐检查，成功响应不暴露验证码。

### POST /api/user/login

```json
{ "email": "user@example.com", "code": "123456" }
```

验证码 10 分钟内有效，最多尝试 5 次。成功写入用户 Cookie并返回用户与额度。

### POST /api/user/logout · GET /api/user/me

退出当前会话，或返回当前用户与额度。以下接口均要求用户会话。

### GET /api/user/overview

返回两档额度、最近一小时统计、在线模型和最近一小时最多 100 条日志。

### GET /api/user/keys · POST /api/user/keys

列出自己的 Key，或使用 `{ "name": "我的 Agent" }` 创建。每个用户最多 3 个启用的 Key，完整 Key 仅创建时返回。

### PATCH /api/user/keys/:id

只能停用自己的 Key：`{ "enabled": false }`，恢复时为 `true`。

## 管理员用户管理

### GET /api/admin/users?search=

按邮箱前缀或数字用户 ID 使用 SQLite 查询，最多返回 50 个用户，包含 Key 数、启用状态和两档额度。

### PATCH /api/admin/users/:id

```json
{ "token_quota_5h": 2000000, "token_quota_week": 20000000, "enabled": true }
```

`0` 表示对应窗口不限。停用后该用户所有 Key 返回 `401`。

### POST /api/admin/users/:id/reset

```json
{ "scope": "five_hours" }
```

`scope` 支持 `five_hours`、`week`、`all`。重置只更新额度起算时间，不删除调用日志。

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
