# 自定义供应商与模型别名

管理员可以在“供应商与模型”中同时管理本地反向隧道和云端直连供应商。每个供应商可以配置多个模型。

## 供应商类型

| 类型 | 连接方式 | 适用场景 |
| --- | --- | --- |
| 本地反向隧道 | `utoken` 主动建立 WebSocket/WSS | 家中无公网 IP 的 llama.cpp、vLLM、SGLang |
| OpenAI 兼容云端 | 云端服务器直接请求上游 `/v1/*` | OpenAI 及兼容服务 |
| Anthropic Messages | 云端直接请求 `/v1/messages`，网关转换格式 | Claude Messages API |

直连供应商需要 Base URL 和上游 API Key。密钥使用 AES-256-GCM 加密保存，管理 API 只返回前缀。可以使用 `PROVIDER_ENCRYPTION_KEY` 指定主密钥，否则在数据目录生成权限为 0600 的 `provider.secret`，备份时需要一起保存。

Anthropic 直连目前支持文本、base64 图片以及普通和流式聊天，不支持工具调用和非聊天接口。

## 模型别名

每个模型同时保存：

- `name`：调用方使用的对外模型名；
- `upstream_name`：发送给上游供应商的真实模型名。

例如：

```text
fast → gpt-4.1-mini
claude-fast → claude-sonnet-4-5
```

客户端始终请求 `fast` 或 `claude-fast`，更换上游模型时无需修改客户端。模型列表也只暴露别名。

## 客户端校验

每个供应商可以独立设置 User-Agent 规则，留空表示不校验。

### 正则表达式

```regex
^Umeko/0\.7\.2$
```

只允许 `Umeko/0.7.2`。

### 模板匹配

```text
Umeko/*
```

`*` 匹配任意内容，整个 User-Agent 必须匹配模板。

不匹配时返回 HTTP `403`，可以配置：

- `client_error_field`：OpenAI `error` 对象内的自定义字段名；
- `client_error_code`：错误代码；
- `client_error_message`：错误提示，支持 `{{provider}}` 和 `{{userAgent}}` 占位符。

示例：

```json
{
  "error": {
    "message": "请升级 Umeko 客户端",
    "type": "api_error",
    "vendor_message": "请升级 Umeko 客户端",
    "code": "upgrade_client"
  }
}
```

## 并发与计费

直连和隧道供应商都使用供应商最大并发限制。价格按对外模型配置，转发别名不影响计费。云端请求结束后统一提取 usage 并写入日志。
