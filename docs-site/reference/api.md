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

云端对聊天流式请求补充 `stream_options.include_usage=true`。成功响应的状态、非 hop-by-hop 响应头和正文来自上游，额外返回 `x-request-id`；上游错误正文会按下方规则追加管理员提示。

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

## 限额与上游错误

API Key 或账户的五小时、周 Token 限额耗尽时，请求在鉴权阶段返回 HTTP 429，不会转发到上游。即使请求使用 `stream: true`，也返回普通 JSON 错误。

OpenAI 兼容格式示例：

```json
{
  "error": {
    "message": "API Key 的五小时 Token 限额已用尽，预计于 2026-11-17T20:00:00.000Z 恢复（1小时30分钟后）",
    "type": "rate_limit_error",
    "reset_at": "2026-11-17T20:00:00.000Z",
    "retry_after_seconds": 5400,
    "quota_window": "5h"
  }
}
```

Anthropic 兼容格式使用外层 `type: "error"`，`error` 中同样包含上述字段。`reset_at` 是 UTC ISO 8601 时间，`retry_after_seconds` 是建议等待秒数，`quota_window` 为 `5h` 或 `week`，响应还包含十进制秒数的 `Retry-After` 头。恢复时间按滚动窗口内的实际 Token 记录计算，不是固定的整点重置。

上游返回非 2xx 状态或连接失败时，错误消息会追加“请联系管理员”。该规则适用于 OpenAI JSON、Anthropic JSON 和上游 SSE 错误，原始 HTTP 状态和可用错误信息保留；成功响应不追加此提示。

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
| `status` | 按 HTTP 状态筛选：`success` 为 200–399，`error` 为其他状态 |
| `category` | 可选请求分类，见下表 |

每页 30 条，返回 `logs`、`total`、`page`、`pages`。每条日志包含请求 ID、模型、Token、费用、延迟、状态、错误原因，以及 `category`、`ip`、`ip_region`、`headers_json` 和解析后的 `headers`。`ip_region` 为公网 IP 的国家、省/州、城市，或“内网地址”“本地地址”；查询进行中或失败时为空。不保存提示词与模型输出正文。

| `category` | 含义 |
| --- | --- |
| `success` | 正常完成 |
| `client_mismatch` | User-Agent 不匹配，已返回客户端提示流 |
| `rate_limit` | Key 额度、RPM 或并发受限 |
| `auth_error` | Key 缺失、无效、过期或无模型权限 |
| `request_error` | 请求格式错误 |
| `provider_offline` | 模型不存在或供应商离线 |
| `upstream_auth` | 上游返回 401/403，供应商凭据鉴权失败 |
| `upstream_error` | 其他上游错误或连接中断 |
| `error` | 其他错误，或旧版日志未记录分类 |

接口最多返回最近 300 条可见日志，最近 150 条始终处于保留范围内，所有可见日志的请求详情均不按时间过期。超出 300 条的旧日志及其 IP、地区、请求头、错误详情会从日志页面移除，Token、费用、状态和时间等统计字段继续用于计费与限额。公网归属地异步查询并缓存，内网地址不会外发查询。`Authorization`、`x-api-key` 和 `Cookie` 入库前始终替换为 `[redacted]`。

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

返回 Key 列表、累计用量、当前并发和额度，不返回 Key 哈希或完整明文。`usage_5h` 和 `usage_week` 分别表示当前五小时、七天滚动窗口内已使用的 Token，计算时包含对应的手动重置起算时间。

### POST /api/admin/keys

```json
{
  "name": "Alice 的应用",
  "allowed_models": ["qwen3-32b"],
  "client_mode": "regex",
  "client_pattern": "^Umeko-Desktop",
  "client_error_message": "当前客户端是 {{userAgent}}，请改用 Umeko Desktop。",
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

`quota_5h` 和 `quota_week` 按当前 Key 的滚动窗口日志限制。`allow_user_apply=true` 时，注册用户可按该策略申请自己的新 Key，不会获得原始 Key。额度为 `0` 表示不限制，`expires_at` 可省略或为 `null`。

`client_pattern` 为空时不限制 User-Agent；`client_mode` 支持 `regex` 和 `template`。不匹配时，OpenAI 与 Anthropic 入口均以 SSE 返回 `client_error_message`，支持 `{{userAgent}}` 占位符，长度为 1–2000 字。省略该字段时使用“请使用umeko-desktop来提问吧”，已有 Key 升级后也保留此默认值。

成功返回：

```json
{ "id": 1, "key": "umo-sk-..." }
```

### PATCH /api/admin/keys/:id

支持创建时的字段以及：

- `enabled`：启用或停发；
- `expires_at`：修改或清空过期时间；
- `reset_window: "5h"`：只重置五小时窗口起算点，累计 Token、费用和周窗口不变；
- `reset_window: "week"`：只重置周窗口起算点，累计 Token、费用和五小时窗口不变；
- `reset_usage: true`：累计 Token 和费用清零，并重置五小时/周起算点，历史日志保留。

### GET /api/admin/keys/:id/reveal

管理员解密查看已有 Key 的完整内容。新 Key 使用 AES-256-GCM 加密存储，不会在列表接口返回。早期仅保存哈希的旧 Key 返回 `legacy: true`，无法恢复原文。

### POST /api/admin/keys/:id/rotate

替换指定 Key 的凭据，保留名称、额度和限流配置。旧 Key 立即失效，新完整 Key 仅返回一次，用于管理员复制 Base URL、Model ID 和接入环境变量。

### GET /api/admin/blocked（兼容接口）

管理界面已统一使用 `/api/admin/usage`，不再有独立的拦截记录页面。此兼容接口从最近 300 条可见日志中返回最多 200 条 `category=client_mismatch` 的记录，字段结构与统一日志一致。新集成请使用 `/api/admin/usage?category=client_mismatch`。

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
{ "email": "user@example.com", "password": "your-password" }
```

日常密码登录。密码使用 scrypt 加盐哈希验证，成功写入用户 Cookie并返回用户与额度。

### POST /api/user/password

```json
{ "email": "user@example.com", "code": "123456", "password": "new-password" }
```

用于注册、忘记密码和修改密码。验证码 10 分钟内有效，最多尝试 5 次；新密码要求 10 到 128 个字符。成功后设置或更新密码并创建用户会话。

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
