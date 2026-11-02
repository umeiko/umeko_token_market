# 部署与更新

## 云端运行要求

- Node.js 22.13 或更高版本；
- 可持久化写入的 `data` 目录；
- 生产环境中的域名和有效 TLS 证书；
- 单个云端应用进程。当前并发状态、会话和隧道位于进程内，不支持直接多进程共享运行。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | 云端监听地址 |
| `PORT` | `3000` | 管理面板与公开 API 端口 |
| `DATA_PATH` | `data/market.db` | SQLite 数据库路径 |
| `ADMIN_USERNAME` | `admin` | 首次初始化管理员账号 |
| `ADMIN_PASSWORD` | 随机生成 | 首次初始化密码；未设置时打印到终端 |
| `COOKIE_SECURE` | `false` | HTTPS 部署应设为 `true` |
| `TRUST_PROXY` | `false` | 位于可信反向代理后时设为 `true` |
| `LOG_LEVEL` | `info` | Fastify 日志级别 |

管理员初始化变量只在数据库没有管理员时生效。后续可在“系统设置”中修改密码。

## 构建与启动

```bash
npm ci --no-bin-links
npm run build
HOST=127.0.0.1 PORT=3000 \
ADMIN_USERNAME=admin ADMIN_PASSWORD='替换为强密码' \
COOKIE_SECURE=true TRUST_PROXY=true \
npm start
```

在仅有反向代理访问云端的部署中，`HOST=127.0.0.1` 可以减少直接暴露。

## 子路径部署

如果中转站与主站共用域名，例如将中转站放在 `https://umekolab.cn/api_seller/`，构建和启动时分别设置前端与服务端前缀：

```bash
VITE_BASE=/api_seller/ npm run build
BASE_PATH=/api_seller HOST=127.0.0.1 PORT=3100 npm start
```

此时管理面板位于 `/api_seller/`，公开模型地址为 `/api_seller/v1`，本地连接地址使用 `https://umekolab.cn/api_seller`。Nginx 的 `proxy_pass` 不要添加末尾 `/`，以保留完整前缀：

```nginx
location = /api_seller { return 301 /api_seller/; }
location /api_seller/ {
  proxy_pass http://127.0.0.1:3100;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection $connection_upgrade;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_read_timeout 3600s;
  proxy_buffering off;
}
```

## Nginx HTTPS / WSS

以下示例假设证书和 HTTP 跳转已由 Certbot 等工具配置：

```nginx
map $http_upgrade $connection_upgrade {
  default upgrade;
  ''      close;
}

server {
  listen 443 ssl;
  server_name api.example.com;

  # ssl_certificate / ssl_certificate_key 按实际路径配置

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_buffering off;
  }
}
```

WebSocket 路径 `/agent/connect` 使用同一站点，无需单独公网端口。`proxy_buffering off` 有助于及时转发 SSE 分块。

## 数据与备份

核心数据位于 SQLite：

- 管理员账号；
- 供应商、模型和价格；
- API Key 哈希、额度和累计用量；
- 请求日志与设置。

备份前建议停止云端进程，然后复制 `data/market.db`。WAL 模式下不要只复制运行中数据库的主文件。升级前始终保留备份。

## 更新云端

```bash
git pull
npm ci --no-bin-links
npm run build
# 按你的服务管理方式重启云端
```

数据库结构通过 `CREATE TABLE IF NOT EXISTS` 和兼容初始化语句处理。更新后检查管理面板、供应商重连和一次真实模型调用。

## 构建与更新 utoken

```bash
git pull
cmake -S local-app -B local-app/build -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build local-app/build
utoken down
# 替换 PATH 中的 utoken 后：
utoken up
```

`utoken` 的配置保存在当前用户 QSettings 中，不包含在仓库里。若使用 systemd，则改用 `utoken serve`，由服务管理器完成重启。
