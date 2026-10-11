# Rental Car 车辆共享看板

完全使用 JavaScript（Node.js）实现的租车公司共享看板。支持双店约 250 台车、9 个停车区域、登录认证、按车种着色、拖动车辆并保存位置、洗车/加油/维修状态筛选，以及 WebSocket 实时刷新。SQLite 持久化车辆、账户和登录会话；密码使用 scrypt 加盐哈希。系统不记录车辆移动审计历史。真实车辆名单未提供，因此不会生成虚构车牌；请登录后录入或对接 ERP。

ERP 后续接入时可使用稳定的 `external_id` 标识和可选 API key 保护的同步接口；ERP 更新车辆基础资料不会覆盖看板维护的状态与位置。

## Debian 12 VPS 部署

示例域名为 `board.example.com`，VPS IPv4 为 `203.0.113.10`。先将域名的 DNS A 记录指向 VPS，以下命令中的域名、IP 和 Git 分支按实际情况替换。

### 1. SSH、安全组和系统依赖

```bash
ssh root@203.0.113.10
apt update && apt upgrade -y
apt install -y ca-certificates curl git nginx ufw
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable
```

在 VPS 云控制台的防火墙中也只开放 TCP 22、80、443。Node 服务只绑定 `127.0.0.1:8000`，不要向公网开放 8000 端口。Debian 12 默认 Node 版本不足时，用 NodeSource 安装 Node.js 24 LTS。应用程序、测试、命令行工具和数据库访问全部使用 JavaScript/Node.js 24 内建的 `node:sqlite`，不依赖 Python 或外部 SQLite 模块：

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt install -y nodejs
node --version
npm --version
```

### 2. 创建专用账户并部署代码

先在开发机推送当前分支，然后克隆它（PR 合并后可改为克隆 `main`）：

```bash
adduser --system --group --home /opt/rentalcar rentalcar
git clone --branch chiyamahisayoshi-rentalcar-live-board https://github.com/chiyamahisayoshi/rentalcar.git /opt/rentalcar/app
chown -R rentalcar:rentalcar /opt/rentalcar
cd /opt/rentalcar/app
sudo -u rentalcar npm ci --omit=dev
```

若仓库是 private，使用只读 Deploy Key 或 VPS 上配置的 Git 凭据，不要把 GitHub token 写进命令历史或项目文件。Node 依赖清单和锁文件分别是 `package.json` 与 `package-lock.json`。

### 3. 创建强密钥和首个管理员

把会话签名密钥存入只有 root 可读的文件：

```bash
umask 077
SESSION_SECRET="$(node -e 'console.log(require("node:crypto").randomBytes(48).toString("base64url"))')"
printf 'SESSION_SECRET=%s\nDATABASE_PATH=/opt/rentalcar/data/rentalcar.db\nCOOKIE_SECURE=1\n' "$SESSION_SECRET" > /etc/rentalcar.env
chown root:root /etc/rentalcar.env
chmod 600 /etc/rentalcar.env
install -d -o rentalcar -g rentalcar -m 750 /opt/rentalcar/data
```

创建首个管理账号。密码至少 12 个字符，输入时不会显示在终端：

```bash
cd /opt/rentalcar/app
sudo -u rentalcar env DATABASE_PATH=/opt/rentalcar/data/rentalcar.db node app/create-admin.js
```

启动时应用自动建立 SQLite 表与 9 个停车场。其他操作员可再次运行管理员创建命令；用户名必须唯一。请使用密码管理器保存密码。

### 4. 配置 systemd 自动启动

创建 `/etc/systemd/system/rentalcar.service`：

```ini
[Unit]
Description=Rental Car Live Board
After=network.target

[Service]
Type=simple
User=rentalcar
Group=rentalcar
WorkingDirectory=/opt/rentalcar/app
EnvironmentFile=/etc/rentalcar.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/node app/server.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/opt/rentalcar/data

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now rentalcar
systemctl status rentalcar --no-pager
curl -I http://127.0.0.1:8000/
```

应用只有一个 Node 进程，因此 WebSocket 通知可直接发给全部在线客户端。当前约 250 台车、单台 VPS 使用 SQLite；未来多进程/多实例部署时需迁移为 PostgreSQL，并加入 Redis Pub/Sub 等共享事件通道。

### 5. 配置 Nginx 反向代理和 HTTPS

创建 `/etc/nginx/sites-available/rentalcar`：

```nginx
server {
    listen 80;
    server_name board.example.com;
    client_max_body_size 1m;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/acme;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}
```

```bash
install -d -o www-data -g www-data -m 755 /var/www/acme
ln -s /etc/nginx/sites-available/rentalcar /etc/nginx/sites-enabled/rentalcar
nginx -t
systemctl reload nginx
curl https://get.acme.sh | sh -s email=admin@example.com
~/.acme.sh/acme.sh --set-default-ca --server letsencrypt
~/.acme.sh/acme.sh --issue --webroot /var/www/acme -d board.example.com
install -d -o root -g root -m 700 /etc/ssl/rentalcar
~/.acme.sh/acme.sh --install-cert -d board.example.com \
  --key-file /etc/ssl/rentalcar/privkey.pem \
  --fullchain-file /etc/ssl/rentalcar/fullchain.pem \
  --reloadcmd "systemctl reload nginx"
```

证书安装后，修改 `/etc/nginx/sites-available/rentalcar`，将 server 配置替换为以下 HTTPS 配置，然后执行 `nginx -t && systemctl reload nginx`：

```nginx
server {
    listen 80;
    server_name board.example.com;
    location ^~ /.well-known/acme-challenge/ { root /var/www/acme; }
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl http2;
    server_name board.example.com;
    ssl_certificate /etc/ssl/rentalcar/fullchain.pem;
    ssl_certificate_key /etc/ssl/rentalcar/privkey.pem;
    client_max_body_size 1m;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
    }
}
```

acme.sh 会安装自动续期任务，并在更新证书后重载 Nginx。浏览器使用 HTTPS，Nginx 代理到仅监听本机的 Node HTTP 服务。`COOKIE_SECURE=1` 强制登录 cookie 只经 HTTPS 传送，不要在没有有效 TLS 的情况下开启该设置。

### 6. 登录验收、备份及升级

访问 `https://board.example.com`，用管理员账号录入车辆。用两个浏览器分别登录，验证车辆状态、拖拽及实时同步；在洗车、加油、维修筛选中检查车辆。日志查看：

```bash
journalctl -u rentalcar -f
```

数据库位于 `/opt/rentalcar/data/rentalcar.db`。使用 Node 内建 SQLite backup API 创建一致性备份，并定期把加密备份复制到 VPS 外部：

```bash
sudo -u rentalcar node -e '
const { DatabaseSync, backup } = require("node:sqlite");
const source = new DatabaseSync("/opt/rentalcar/data/rentalcar.db", { readOnly: true });
backup(source, "/opt/rentalcar/data/backup.db")
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => source.close());'
```

更新代码前先备份；PR 合并后再更新生产 `main` 分支：

```bash
cd /opt/rentalcar/app
git pull --ff-only
sudo -u rentalcar npm ci --omit=dev
systemctl restart rentalcar
systemctl status rentalcar --no-pager
```

## 本地开发和测试

安装 Node.js 24 或更新版本，然后运行：

```bash
npm ci
export SESSION_SECRET="$(node -e 'console.log(require("node:crypto").randomBytes(48).toString("base64url"))')"
npm run create-admin
npm start
```

打开 `http://127.0.0.1:8000`。另一个终端运行 `npm test`。`SESSION_SECRET` 是启动必需项；`DATABASE_PATH` 默认为 `data/rentalcar.db`，开发环境 `COOKIE_SECURE` 默认关闭。

## ERP 同步接口

设置 `ERP_API_KEY` 后，ERP 使用 `POST /api/integration/vehicles:sync`，并将密钥放入 `X-ERP-API-Key` 请求头。JSON 数组每项需有 `external_id`、`plate`、`vehicle_type`，可选 `parking_lot_id`。同一外部 ID 的重复同步会更新车牌、车种及停车场，保留看板中的状态与相对位置；每批上限 500 台。未配置 API key 时接口返回 503。

安全生成并添加 ERP 密钥到 `/etc/rentalcar.env`：

```bash
printf 'ERP_API_KEY=%s\n' "$(node -e 'console.log(require("node:crypto").randomBytes(48).toString("base64url"))')" >> /etc/rentalcar.env
systemctl restart rentalcar
```
