# 邮件发件配置

用户门户使用邮箱验证码登录。生产环境推荐使用阿里云 DirectMail 中继，不要在 ECS 上直接通过 25 端口投递。

本部署约定的发件地址为 `admin@umekolab.cn`，SMTP 服务为 `smtpdm.aliyun.com:465`（SSL）。

## 1. 验证发信域名

1. 打开[阿里云 DirectMail 控制台](https://dm.console.aliyun.com/)，添加发信域名 `umekolab.cn`。
2. 按控制台生成的记录，在域名 DNS 服务商处配置 SPF、DKIM、DMARC 和需要的 MX 记录。
3. 返回 DirectMail 控制台，等待域名验证通过。

DNS 记录中的主机名和值以控制台为准，不能使用其他域名的 DKIM 公钥。仅发送验证码不要求在本机安装 Postfix，也不要求开放入站 25 端口。

## 2. 创建发件地址并启用 SMTP

在 DirectMail 中创建 `admin@umekolab.cn`，为该地址开启 SMTP 发信功能并设置 SMTP 密码。官方 SMTP 参数见[阿里云 SMTP 服务地址](https://help.aliyun.com/zh/direct-mail/smtp-endpoints)。

## 3. 配置云端服务

在服务器创建 `/etc/systemd/system/umeko-token-relay.service.d/smtp.conf`：

```ini
[Service]
Environment=SMTP_HOST=smtpdm.aliyun.com
Environment=SMTP_PORT=465
Environment=SMTP_SECURE=true
Environment=SMTP_USER=admin@umekolab.cn
Environment="SMTP_PASS=替换为DirectMail控制台设置的SMTP密码"
Environment=EMAIL_FROM=admin@umekolab.cn
```

然后重启：

```bash
systemctl daemon-reload
systemctl restart umeko-token-relay
journalctl -u umeko-token-relay -n 50 --no-pager
```

密码仅保存在 root 可读的 systemd 配置中，不要提交到 GitHub。

## 4. 验证

在 `https://umekolab.cn/api_login/` 输入一个真实邮箱并发送验证码。检查：

- API 不再返回“邮件服务尚未配置”；
- 收件箱或垃圾邮件文件夹收到六位验证码；
- `journalctl` 中没有 SMTP 鉴权、TLS 或发件域名错误；
- 验证码登录、用户创建和 Key 申请正常。

如果 DirectMail 返回发件地址未验证，请先完成 DNS 验证，不要通过关闭 TLS 或伪造其他域名绕过。
