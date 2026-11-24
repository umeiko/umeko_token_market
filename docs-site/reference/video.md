# 视频生成 API

视频生成在后台运行。客户端先提交任务，保存 Relay 返回的任务 ID，再用同一个 API Key 查询状态。生成成功后从上游提供的临时 URL 下载视频。

## 供应商配置

在「供应商与模型」添加视频供应商，填入对应工作空间或方舟账户的 API Key，配置对外模型别名和上游模型 ID。

| 供应商类型 | Base URL | 上游模型示例 |
| --- | --- | --- |
| 火山方舟 Seedance | `https://ark.cn-beijing.volces.com/api/v3` | `doubao-seedance-2-0-260128` |
| 本地视频隧道 | 通过 utoken 在本机设置地址 | 本地视频服务支持的模型 ID |
| 阿里百炼 Wan 3.0 | `https://<WorkspaceId>.cn-beijing.maas.aliyuncs.com/api/v1` | `wan3.0-video` 或 `wan3.0-video-prime` |

方舟 Agent Plan 使用其专属密钥和 `https://ark.cn-beijing.volces.com/api/plan/v3`。百炼需将工作空间、地域、模型和密钥配成同一套。以厂商实际开通的模型为准。

为视频模型填写每成功生成一条的美元价格（管理 API 的 `output_price`）。然后在「API Key」里明确把视频模型别名加入白名单，并设置大于 0 的费用额度。符合配置的模型在 `GET /v1/models` 带 `modality: "video"`。

API Key 的模型行可以保存仅对这把 Key 生效的对外 Model ID。调用、模型列表和任务响应使用这个 ID。「API 接入信息」列出完整 ID，并在可复制的完整接入信息内附上 H3 OpenAPI JSON 的公网链接。

H3 的机器可读说明位于 `GET /v1/videos/help.json`，包含文生视频、首帧和首尾帧三种请求示例。带上 `Authorization: Bearer ...` 可获取当前 Key 的对外别名。可选的 `?model=...` 用来仅查看一个对外 ID。H3 首尾帧还可以使用 Base64 Data URL，整个请求体上限为 128 KiB。

## 创建和查询

请求相对于 Token Relay 的 API Base URL。示例中的域名、模型别名、密钥和素材地址均需自行替换。

```sh
curl "$RELAY_BASE/v1/videos" \
  -H "Authorization: Bearer $RELAY_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: product-demo-001' \
  --data '{
    "model": "wan-video",
    "prompt": "从静止的产品特写开始，镜头向左缓慢环绕，暖色背景",
    "media": [{"type": "first_frame", "url": "https://assets.example.com/product.jpg"}],
    "duration": 5,
    "ratio": "adaptive",
    "resolution": "720p",
    "audio": false,
    "watermark": false
  }'
```

```sh
curl "$RELAY_BASE/v1/videos/$VIDEO_ID" -H "Authorization: Bearer $RELAY_KEY"
```

提交后通常返回 HTTP 202，响应含 `id`、`model`、`status` 和 `price_micros`。重复提交同一 `Idempotency-Key` 和相同 JSON 请求体可取回原任务，使用相同幂等键提交不同请求返回 409。建议每个新任务生成一个独立幂等键，网络错误时沿用它。上游明确拒绝任务或同一任务已经完成时，提交接口可返回 HTTP 200，请始终检查 `status`。

| 状态 | 含义 |
| --- | --- |
| `submitting` | Relay 正在提交 |
| `queued` / `running` | 排队或生成中 |
| `succeeded` | 已完成，`video_url` 可供下载，`usage` 为上游用量 |
| `failed` / `cancelled` / `expired` | 任务终止，可查看 `error` |
| `submission_unknown` | 上游可能已收到，但 Relay 没拿到任务 ID。应核查上游控制台，换幂等键重试可能产生重复费用 |

Relay 定期查询上游，可在重启后继续同步已保存上游 ID 的任务。客户端建议 10 秒查询一次；上游暂时失败时 Relay 会退避。24 小时未确认结果的任务会过期，终态记录保存 7 天。两家上游的成品链接通常有 24 小时有效期，到期前请下载。

## 输入字段

| 字段 | 含义 |
| --- | --- |
| `model` | 必填，Relay 配置的模型别名 |
| `prompt` | 画面、主体、动作、运镜、风格或对白。与 `media` 至少提供一个 |
| `media` | 带类型的 HTTPS 素材列表。支持 `first_frame`、`last_frame`、`reference_image`、`reference_video`、`reference_audio` |
| `duration` | 输出秒数。支持按上游模型填写整数秒，允许支持自动时长的模型使用 `-1` |
| `ratio` / `resolution` | 宽高比与分辨率分别设置，例如 `9:16` 与 `720p`。首帧等模式可能要求 `adaptive` |
| `audio` / `watermark` | 输出音轨与水印开关 |
| `seed` / `prompt_extend` | Wan 3.0 的随机种子和提示词改写开关 |

尾帧必须与首帧一起使用，首尾帧模式与参考素材模式分开。Wan 3.0 另支持 `file` 或 `link` 素材，合计最多一个。具体模型的素材张数、时长、分辨率、比例和组合限制以上游为准。首版使用 JSON URL 素材，暂未接入素材上传、厂商素材 ID、回调、取消及长期视频存储。

## 本地视频隧道

在云端选择「本地视频隧道」，在 utoken 控制台选择「异步视频生成」。一个供应商对应一个本地服务地址。本地程序只做转发，由独立的生成服务或适配层执行模型。ComfyUI 等工作流服务需要适配到以下接口才能接入。

| 本地接口 | 响应 |
| --- | --- |
| `GET /health` | HTTP 2xx 表示可接单。实际探测路径可在本地控制台修改 |
| `POST /v1/videos` | 接收本文的 JSON 字段，`model` 已替换为本地模型名。立即返回 `{"id":"local-job-1","status":"queued"}` |
| `GET /v1/videos/:localId` | 返回相同 ID 与 `queued`、`running`、`succeeded`、`failed`、`cancelled` 或 `expired` 状态。可带 `duration` 和 `error.code` |
| `GET /v1/videos/:localId/content` | 返回 HTTP 200 和 `video/mp4` 或 `video/webm` 文件流 |

本地任务 ID 只允许字母、数字、连字符、下划线，长度 1 至 160。应使用持久且不重复的 ID，便于连接器断线后恢复轮询。云端查询成功时返回同站相对地址 `content_url`。客户端下载时使用原请求的 Relay API Key。本机需在线且仍保留成品。下载流经过原供应商的隧道，单次限 64 MiB，不需要给成品开放公网端口。

如果服务自行抓取参考素材，请在该服务中限制可访问的地址、重定向和响应体大小。建议每个已配置的云端供应商固定连接同一个本地后端，避免其已有任务被发送到另一个服务。

## 费用与额度

Seedance 按上游返回的视频 Token 及相应规格计费；Wan 3.0 按输入视频和实际输出视频的合计秒数计费，单价随规格变化。参考官方的[方舟模型价格](https://docs.volcengine.com/docs/ark/model-pricing?lang=zh)和[百炼模型价格](https://help.aliyun.com/zh/model-studio/model-pricing)。

Relay 首版按每条成功任务的固定美元价格结算，`price_micros` 和 `cost_micros` 的单位为百万分之一美元。提交时预留该金额，成功时扣一次，失败或过期时释放。未完成任务计入 API Key 和供应商的任务并发，轮询不会重复计费。视频上游用量单独返回，不计入聊天 Token 限额。上游实际账单仍按厂商规则生成，管理员填写的 Relay 价格与上游费用分别计算。

原始接口见[方舟创建视频任务](https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh)和[百炼 Wan 3.0 视频生成](https://help.aliyun.com/zh/model-studio/wan3-video-generation-api-reference)。
