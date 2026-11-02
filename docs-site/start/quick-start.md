# 五分钟上手

这条路径会完成一次真实调用：**云端创建供应商与 Key → 本地 `utoken` 建立反向隧道 → OpenAI 兼容请求返回结果**。

## 准备

- 一台具有公网地址的服务器，Node.js 22.13+。
- 一台运行模型的本地机器，已有 llama.cpp、vLLM 或 SGLang 的 OpenAI 兼容服务。
- 本地机器安装 CMake 3.21+、C++17 编译器和 Qt 6 Quick/QuickControls2/Network。
- 本地机器可以主动访问云端 HTTPS 端口，不需要公网 IP。

## 1. 启动云端

```bash
git clone https://github.com/umeiko/umeko_token_market.git
cd umeko_token_market
npm ci --no-bin-links
npm run build
ADMIN_USERNAME=admin ADMIN_PASSWORD='替换为强密码' npm start
```

打开 `http://服务器地址:3000` 并登录。生产环境不要直接暴露 HTTP，请按[部署指南](/start/install)配置 HTTPS/WSS。

## 2. 确认本地推理服务

以默认端口为例：

```bash
curl http://127.0.0.1:8080/v1/models
```

如果服务使用其他端口，后续修改 `--local-base-url` 即可。`utoken` 不会启动、停止或配置推理进程。

## 3. 构建 utoken

```bash
cmake -S local-app -B local-app/build -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build local-app/build
./local-app/build/utoken --help
```

以下示例假设已将 `utoken` 放入 `PATH`。

## 4. 创建云端供应商

1. 打开“供应商与模型”，点击“添加供应商”。
2. 填写名称和最大并发。`0` 表示不限制。
3. 添加对外模型名称。客户端的 `model` 字段必须与它一致。
4. 设置输入和输出价格，单位为 **美元 / 百万 Token**。
5. 保存并立即复制一次性连接凭据。

供应商凭据以 `umo-agent-` 开头，只能用于本地连接器，不要分发给 API 调用方。

## 5. 建立反向隧道

```bash
utoken up \
  --cloud-url https://api.example.com \
  --provider-id 1 \
  --provider-token 'umo-agent-...' \
  --local-base-url http://127.0.0.1:8080
```

`utoken up` 启动后台服务并立即返回。检查两种状态：

```bash
utoken status
```

正常结果包含 `Cloud: online` 和 `Local inference: online`。也可以打开 `http://127.0.0.1:8787`，或运行 `utoken ui` 使用 QML 界面。

## 6. 创建调用方 API Key

在云端“API Key”页面创建 Key。建议为每个用户或应用单独创建，并设置：

- Token 总额度和费用额度；
- 每分钟请求数；
- 最大并发；
- 可选过期时间。

完整 `umo-sk-...` 只显示一次。云端只保存哈希。

## 7. 发起第一次调用

```bash
curl https://api.example.com/v1/chat/completions \
  -H 'Authorization: Bearer umo-sk-...' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "your-model-name",
    "messages": [{"role":"user","content":"用一句话介绍你自己"}],
    "stream": false
  }'
```

流式请求将 `"stream": false` 改成 `true`。随后在云端“用量与账单”和“请求日志”中检查 Token、费用、延迟与状态。

## 下一步

- [理解反向中转架构](/reference/architecture)
- [管理本地服务](/guide/local)
- [配置额度与并发](/guide/billing)
- [生产安全检查](/guide/security)
