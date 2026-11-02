# 开发与构建

## 技术栈

| 部分 | 技术 |
| --- | --- |
| 云端 | Node.js 22、Fastify 5、WebSocket、node:sqlite |
| 云端管理面板 | Vue 3、Vite |
| 本地核心 | C++17、Qt 6 Network |
| 本地桌面界面 | Qt 6 Quick / QML |
| 本地 Web | Qt 静态资源、原生 HTML/CSS/JavaScript |
| 文档站 | VitePress |

## 云端开发

```bash
npm ci --no-bin-links
npm run dev:server
```

另一个终端启动 Vite：

```bash
npm run dev:ui
```

Vite 开发地址为 `http://127.0.0.1:5173`，`/api`、`/v1` 和 `/agent` 代理到 `127.0.0.1:3000`。

生产构建：

```bash
npm run build
npm start
```

当前文件系统不支持 npm 可执行符号链接，因此脚本直接调用 Vite 的 Node 入口；`--no-bin-links` 也可在其他平台使用。

## 本地 Qt 开发

```bash
cmake -S local-app -B local-app/build -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build local-app/build -j2
./local-app/build/utoken --help
```

无显示服务器时可用 Qt 离屏平台检查 QML 加载：

```bash
QT_QPA_PLATFORM=offscreen ./local-app/build/utoken --gui
```

`--gui` 是 QML 前端模式，需要已有 `utoken up` 管理服务。

## 文档站开发

```bash
cd docs-site
npm ci --no-bin-links
npm run dev
```

默认文档开发地址由 VitePress 输出。生产构建：

```bash
DOCS_BASE=/umeko_token_market/ npm run build
```

输出位于 `docs-site/.vitepress/dist`。GitHub Pages 由 `.github/workflows/docs.yml` 自动构建和部署。

## 端到端验证建议

每次修改转发逻辑后，至少验证：

1. 本地健康检查和供应商上线；
2. `/v1/models`；
3. 非流式聊天；
4. SSE 流式聊天和最终 usage；
5. Token/费用入账；
6. 无效 Key、超额和超并发；
7. `utoken stop → up → down`；
8. Web 与 QML 状态同步。

修改云端依赖后运行 `npm audit` 和生产构建。修改 QML 后同时检查编译和实际页面加载，不能只依赖 C++ 编译成功。

## 代码边界

- 推理参数兼容和准入逻辑放在云端 Gateway；
- WebSocket 帧与请求关联放在 Tunnel/Transport；
- 本地 GUI 不直接实现转发；
- 管理 API 不返回完整凭据；
- 请求日志不记录提示词和输出正文。
