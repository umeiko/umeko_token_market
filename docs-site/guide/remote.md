# 私人远程工作台

远程工作台供电脑所有者出差时使用，与 Token Relay 用户账号、管理员密码、API Key 完全隔离。入口为站点的 `/remote/`，也可从管理员侧栏进入。

## 日常使用

1. 在家中电脑打开 **Umeko 远程连接器**。点击“开启开机自启动”，以后开机会自动建立连接，无需显示器或登录桌面。
2. 电脑需要持续供电、联网，并避免自动休眠。连接器不能从关机状态启动电脑。
3. 在出差设备打开工作台，选择自己的 `admin.umeko-key` 文件登录。
4. 工作台显示在线状态、系统运行时间，以及 SSH、桌面服务状态。
5. 点击“连接桌面”，输入家中电脑的系统账号和密码；也可将密码留空，在 xrdp 登录画面中输入。
6. 使用完毕后断开桌面并退出工作台。本机点击“断开”会关闭全部反向连接。开启自启动后，关闭窗口仍保持后台连接；未开启时关闭窗口会断开。

离线表示连接器不可达，可能是关机、断网、休眠或连接器未运行。页面不会把“离线”直接解释成“已关机”。网络恢复后，连接器自动重连。

浏览器内的桌面由已有的 **xrdp** 服务提供，可能是单独的图形会话，不保证与物理显示器上的桌面相同。工作台支持键盘、鼠标、触摸、全屏和文本剪贴板。远程 MATE 会话独立启动 Fcitx5 拼音输入法；点击桌面工具栏“中/英”或按 Ctrl + 空格切换，输入拼音后用空格选择候选词。网页“键盘”输入框也支持在出差设备上输入中文后发送。

## 网页终端与文件管理

使用工作台密钥登录后，点击“网页终端”即可连接家中电脑的系统账号。支持交互式 Shell、终端尺寸调整、中文输入、复制粘贴和 Ctrl C。关闭终端会结束该 Shell；需要长期运行的任务请在 tmux 或 screen 中执行。

点击“管理文件”，或桌面工具栏“文件”，可在电脑的不同目录之间切换。支持输入绝对路径、返回主目录或上一级、显示隐藏文件、新建文件夹、批量选择文件上传和下载。权限与配置的系统用户相同。上传直接流式写入目标目录，使用临时文件并在成功后重命名；同名文件拒绝覆盖，取消或失败会清理临时文件。每个上传文件最多 2 GiB，页面显示上传进度并提供取消按钮。下载也直接流式传输，不保存在云端磁盘。

网页 SSH / SFTP 通过既有连接器的 SSH 通道访问本机，只在云端配置专用 SSH 凭据，并固定验证家中电脑的 Ed25519 SSH 主机指纹。网站登录私钥仍只在浏览器签名。退出或登录到期会关闭网页终端和文件连接。

## SSH 与 VS Code

在工作台展开“原生 SSH 连接方法”，下载独立的 `umeko-remote.mjs`。出差设备需要 Node.js 22 或更高版本，不需要安装 npm 依赖。

```bash
node umeko-remote.mjs --identity /path/to/admin.umeko-key --url https://your-domain.example/remote
```

隧道工具只监听出差设备的 `127.0.0.1:2222`。保持窗口打开，在另一个终端连接：

```bash
ssh -p 2222 -o HostKeyAlias=umeko-home your-user@127.0.0.1
```

工作台密钥只授权隧道。SSH 本身仍验证家中电脑原有的 SSH 密钥或系统密码，并使用 SSH 的端到端加密。

VS Code Remote SSH 可使用：

```text
Host umeko-home
    HostName 127.0.0.1
    Port 2222
    User your-user
    HostKeyAlias umeko-home
    # IdentityFile ~/.ssh/your-home-computer-key
```

关闭隧道工具即停止转发。会话最长 8 小时，到期后重新运行工具。关闭网页会话会终止属于该会话的桌面连接；独立启动的 CLI 隧道具有自己的密钥会话。

## 密钥与访问边界

- `admin.umeko-key`：所有者的登录私钥，应提前安全备份到出差设备。文件在浏览器中完成 Ed25519 签名，私钥不会发送给服务器，也不会存入网页本地存储。
- `device.umeko-key`：家中电脑的连接器私钥，不要携带给其他人。设备身份不能作为网页管理身份登录。
- 服务器配置保存工作台管理员和连接器身份的公钥；可选的网页 SSH 使用独立的服务凭据。挑战 60 秒有效且只可使用一次；连接票据 30 秒有效且只可使用一次。
- 管理会话使用 Secure、HttpOnly、SameSite=Strict Cookie，最长 8 小时。退出或到期会关闭该会话的连接。
- 系统密码仅短暂用于建立当前 RDP 会话，不写入配置、日志或数据库。
- 管理界面禁止跨站嵌入，API 和浏览器 WebSocket 校验 Origin。设备与 SSH CLI 通过签名身份或一次性票据验证。
- 连接器仅转发预先配置的 `127.0.0.1` SSH / RDP 端口，不提供任意目标地址或任意命令执行接口。
- 不新增公网 SSH、RDP、VNC 或 guacd 监听端口。远程工作台只通过现有 HTTPS 入口访问。

密钥文件遗失或泄露后，在安全的本地环境生成新密钥，将服务器相应公钥替换并重启 `umeko-remote`。重启会撤销全部会话和票据。不要把私钥、实际配置或系统密码提交到 Git。

## 部署

工作台是独立 Node.js 进程，不依赖 Token Relay 的 SQLite 数据库或管理员认证。现有中转服务继续单进程运行。

服务器需要 Node.js 22 和 Apache Guacamole **guacd 1.6.0**，其中启用 RDP 协议。Debian 13 可从 Apache 官方源码构建，安装 `freerdp3-dev` 等构建依赖。FreeRDP 3 在该 Guacamole 版本中属于实验支持，部署后需要实际验证桌面连接。某些 FreeRDP 版本在头文件中触发弃用警告，可通过配置时设置 `CFLAGS='-O2 -Wno-error=deprecated-declarations'` 处理；保留其他编译错误检查。

`remote/vendor/` 保留 Apache Guacamole 官方 JavaScript 客户端及许可证，不通过第三方 CDN 加载代码。

先在仓库外的私密目录生成密钥：

```bash
node remote/keys.js /private/path/umeko-remote
```

创建仅服务账号可读的 `/etc/umeko-remote/server.json`。示例中的公钥来自生成的 `public-keys.json`：

```json
{
  "origin": "https://your-domain.example",
  "path": "/remote",
  "port": 3101,
  "guacdPort": 4822,
  "desktopUser": "your-user",
  "stateFile": "/var/lib/umeko-remote/state.json",
  "adminKeys": [{"id": "ADMIN_KEY_ID", "publicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n"}],
  "device": {"id": "DEVICE_KEY_ID", "publicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n", "name": "家中电脑"}
}
```

创建独立的 `umeko-remote` 系统账号、配置目录和可写状态目录。将该账号的 home 设置为 `/var/lib/umeko-remote/home`，由该账号持有且权限 700，以便 FreeRDP 写入运行配置。安装 `remote/deploy/` 中的两个 systemd unit。检查 unit 的 Node.js、guacd 和应用路径。两个进程均只监听回环地址：Node.js `127.0.0.1:3101`、guacd `127.0.0.1:4822`。

启用网页终端和文件管理时，额外在服务器私密目录生成专用 OpenSSH Ed25519 密钥，将公钥加入家中电脑目标用户的 `~/.ssh/authorized_keys`。建议加 `from="127.0.0.1",restrict,pty` 限制，只允许现有连接器从本机回环接入，禁用端口、Agent 和 X11 转发并允许终端。云端私钥只能由工作台服务账号读取，不加入仓库。配置中添加：

```json
"webSsh": {
  "username": "your-user",
  "privateKeyFile": "/etc/umeko-remote/home_ssh",
  "hostKeySha256": "SHA256:HOME_ED25519_HOST_KEY_FINGERPRINT"
}
```

在家中电脑用 `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256` 获取主机指纹，通过可信方式写入配置；连接时必须匹配该主机指纹。未配置 `webSsh` 时，网页终端和文件入口禁用，已有桌面和原生 SSH 隧道继续可用。终端使用项目依赖中的 xterm.js，随服务提供，无需 CDN。

将 `remote/deploy/nginx.conf` 的 location 配置加入现有 HTTPS server，备份后运行 `nginx -t`，通过后再 reload。 文件上传需要 `client_max_body_size 2g` 与 `proxy_request_buffering off`；Node.js 对普通 API 继续使用 16 KiB 限制，上传路由单独执行 2 GiB 流量限制。

```bash
systemctl daemon-reload
systemctl enable --now umeko-guacd umeko-remote
nginx -t && systemctl reload nginx
```

本机配置放在 `~/.config/umeko-remote/agent.json`，权限 600：

```json
{
  "url": "https://your-domain.example/remote",
  "identity": "/private/path/device.umeko-key",
  "sshPort": 22,
  "rdpPort": 3389
}
```

在已安装项目 npm 依赖的家中电脑运行桌面连接器，或使用 CLI：

```bash
python3 remote/desktop.py ~/.config/umeko-remote/agent.json
node remote/agent.js ~/.config/umeko-remote/agent.json
```

桌面界面需要 Python 3 的 Tkinter，只负责控制独立的 Node.js 后台服务。点击“开启开机自启动”会注册 `umeko-remote-agent.service` 用户服务并为当前用户启用 linger，让用户服务管理器在系统启动时运行、退出登录后继续运行。系统不允许设置 linger 时，界面会显示错误，不会把“桌面登录后自启”当成真正的开机启动。

后台运行文件安装到 `~/.local/share/umeko-remote/`，配置与设备密钥留在 `~/.config/umeko-remote/`，不依赖项目所在的外置或 DATA 磁盘。服务直接启动 Node.js，清除图形显示环境变量，并会在网络暂不可用时重试连接。已有的 SSH 和 xrdp 系统服务也应设置为开机启动；xrdp 使用自己的虚拟图形会话，无需物理显示器。

开启自启动后关闭窗口不会停止服务；“断开”只停止当前连接，下次开机仍自动连接。关闭“开机自启动”只取消后续开机启动，不会修改其他用户服务所需的 linger 设置。未开启自启动时，关闭窗口会停止本次连接。该功能不会更改系统桌面自动登录、引导器、休眠或固件设置。

无图形环境下也可以使用同一控制器：

```bash
python3 remote/service.py enable --config ~/.config/umeko-remote/agent.json
python3 remote/service.py status
python3 remote/service.py stop
python3 remote/service.py start
python3 remote/service.py disable
```

桌面启动器在缺少 `DISPLAY` 和 `WAYLAND_DISPLAY` 时会直接启动后台服务，不创建窗口；也可显式传 `--headless`。开机服务自身不导入 Tkinter。

```bash
python3 remote/desktop.py --headless
systemctl --user status umeko-remote-agent.service
journalctl --user -u umeko-remote-agent.service -n 30 --no-pager
loginctl show-user "$USER" -p Linger
```

## 验证与排障

```bash
npm run remote:test
npm run remote:test:service
systemctl status umeko-remote umeko-guacd
journalctl -u umeko-remote -n 50 --no-pager
```

集成测试覆盖签名认证、错误公钥、重放、角色隔离、跨域限制、在线状态、原生 SSH 流量、退出断连、设备断连及 guacd 握手。部署后应另外验证真实 xrdp 登录画面和 SSH 主机指纹。

无法连接桌面时，检查本机 xrdp 是否监听配置端口、连接器是否在线、guacd 服务是否运行。网页无法登录时，确认使用管理员密钥、浏览器支持 Ed25519 Web Crypto，并检查域名是否与配置的 origin 完全一致。

如果系统认证成功后马上断开，检查 `/var/log/xrdp-sesman.log` 和自己的 `~/.xorgxrdp.*.log`。MATE 在 xrdp 虚拟显示器上进行图形加速检查时，可能在 `gl_failed` 后以 139 退出；此时隧道仍然在线，真正结束的是桌面会话。对于使用 MATE 的 xrdp 会话，可以备份已有的 `~/startwm.sh` 后，采用 `remote/deploy/startwm.sh` 中的启动方式：独立 D-Bus 会话、强制 X11、软件渲染及 `--disable-acceleration-check`。这些环境变量只作用于远程桌面，不更改物理显示器上的 KDE 会话。不要在未备份用户自定义会话脚本时直接覆盖它。
