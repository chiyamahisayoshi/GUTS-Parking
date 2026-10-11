# Rental Car 車両配置ボード

レンタカー会社向けの共有車両配置ボードです。9か所の駐車場、車種カラー、車両のドラッグ移動、洗車・給油・修理ステータス、ユーザー名とパスワードによるログインに対応します。SQLiteに保存し、WebSocketで変更を同時接続中の利用者に通知します。操作履歴は記録しません。

## VPS へ配置する (Debian 12)

以下では VPS の IP を `203.0.113.10`、ホスト名を `board.example.com`、アプリ専用ユーザーを `rentalcar` とします。作業前に DNS の A レコードを VPS に向けてください。コマンド中のホスト名・メールアドレスを実際の値に置き換えます。

### 1. サーバーの初期設定

SSH で VPS に接続し、OS を更新して Python、Nginx、TLS 証明書ツールを入れます。

```bash
ssh root@203.0.113.10
apt update && apt upgrade -y
apt install -y python3 python3-venv python3-pip nginx certbot python3-certbot-nginx ufw
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable
```

クラウド VPS 側のファイアウォールでも TCP 22、80、443 のみを許可してください。Uvicorn の 8000 番ポートはインターネットに公開しません。

### 2. アプリを配置して仮想環境を作る

GitHub にこのブランチを push した後、サーバーで clone します。未 push の場合は開発端末で `git push -u origin chiyamahisayoshi-rentalcar-live-board` を実行してください (main に未マージの場合は clone に `--branch chiyamahisayoshi-rentalcar-live-board` を指定します)。

```bash
adduser --system --group --home /opt/rentalcar rentalcar
git clone https://github.com/chiyamahisayoshi/rentalcar.git /opt/rentalcar/app
chown -R rentalcar:rentalcar /opt/rentalcar
cd /opt/rentalcar/app
sudo -u rentalcar python3 -m venv .venv
sudo -u rentalcar .venv/bin/pip install --upgrade pip
sudo -u rentalcar .venv/bin/pip install -r requirements.txt
```

リポジトリが private の場合は deploy key またはサーバーに設定した GitHub 認証を使います。GitHub トークンをコマンドラインやこのアプリのファイルに書かないでください。

### 3. 秘密鍵を設定し、最初の管理者を作成する

アプリのセッション署名鍵を生成し、root のみが読める環境ファイルに保存します。

```bash
install -o root -g root -m 600 /dev/null /etc/rentalcar.env
SESSION_SECRET="$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')"
printf 'SESSION_SECRET=%s\nDATABASE_PATH=/opt/rentalcar/data/rentalcar.db\nCOOKIE_SECURE=1\n' "$SESSION_SECRET" > /etc/rentalcar.env
chown root:root /etc/rentalcar.env
chmod 600 /etc/rentalcar.env
install -d -o rentalcar -g rentalcar -m 750 /opt/rentalcar/data
```

建立第一个登录账户（密码至少 12 位；终端会隐藏输入。请用密码管理器生成并保存密码）：

```bash
cd /opt/rentalcar/app
sudo -u rentalcar env SESSION_SECRET="$SESSION_SECRET" DATABASE_PATH=/opt/rentalcar/data/rentalcar.db .venv/bin/python -m app.create_admin
```

首次启动应用时会自动创建数据库表并初始化 9 个停车场。因为真实车牌清单尚未提供，请在界面逐台录入车辆，或后续接入 ERP；程序不会生成虚构车辆。之后可使用相同命令增加其他操作员；每个用户名必须唯一。

### 4. 建立 systemd 服务

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
ExecStart=/opt/rentalcar/app/.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 1
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/opt/rentalcar/data

[Install]
WantedBy=multi-user.target
```

启动并确认服务状态：

```bash
systemctl daemon-reload
systemctl enable --now rentalcar
systemctl status rentalcar --no-pager
curl -I http://127.0.0.1:8000/
```

只运行 **一个 worker**：当前 WebSocket 通知连接保存在单进程内存中。单进程适合当前团队规模；若未来要多 worker 或多台应用服务器，应迁移到 Redis Pub/Sub 或同类共享消息总线。SQLite 和一台 VPS 适用于当前约 250 台车的看板规模。

### 5. 配置 Nginx 及 HTTPS

创建 `/etc/nginx/sites-available/rentalcar`：

```nginx
server {
    listen 80;
    server_name board.example.com;
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

```bash
ln -s /etc/nginx/sites-available/rentalcar /etc/nginx/sites-enabled/rentalcar
nginx -t
systemctl reload nginx
certbot --nginx -d board.example.com
```

`COOKIE_SECURE=1` 要与 HTTPS 一起启用；HTTPS 终止于 Nginx，浏览器和 Nginx 之间使用 HTTPS，Nginx 到仅监听 localhost 的 Uvicorn 使用 HTTP。续期由 Certbot timer 自动处理，可用 `certbot renew --dry-run` 检查。

### 6. 首次登录及验收

访问 `https://board.example.com`，用第 3 步创建的账号登录，添加车辆，测试状态筛选及跨停车场拖拽。用两个浏览器登录，确认一端操作后另一端很快更新。检查服务日志：

```bash
journalctl -u rentalcar -f
```

### 数据备份与升级

SQLite 数据库位于 `/opt/rentalcar/data/rentalcar.db`。备份应保存到 VPS 以外，并限制备份可读人员；推荐用 SQLite 在线备份 API：

```bash
sudo -u rentalcar /opt/rentalcar/app/.venv/bin/python -c \
  'import sqlite3; s=sqlite3.connect("/opt/rentalcar/data/rentalcar.db"); d=sqlite3.connect("/opt/rentalcar/data/backup.db"); s.backup(d); d.close(); s.close()'
```

升级前做备份，再 pull 部署分支、安装依赖并重启服务：

```bash
cd /opt/rentalcar/app
git pull --ff-only
sudo -u rentalcar .venv/bin/pip install -r requirements.txt
systemctl restart rentalcar
systemctl status rentalcar --no-pager
```

## 本地开发和测试

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements-dev.txt
export SESSION_SECRET="$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')"
python -m app.create_admin
uvicorn app.main:app --reload
```

再开一个终端运行 `pytest -q`。Windows PowerShell 的虚拟环境激活命令为 `.venv\Scripts\Activate.ps1`。

## ERP 对接预留

每台车有稳定的 `external_id` 字段。可选环境变量 `ERP_API_KEY` 配置后，ERP 使用 `POST /api/integration/vehicles:sync`，并在 `X-ERP-API-Key` 请求头中发送密钥。请求 JSON 为数组，每项包含 `external_id`、`plate`、`vehicle_type`，以及可选 `parking_lot_id`。同一个外部 ID 重复同步会更新车牌、车辆类型和停车场，不会覆盖看板维护的状态和精确位置。接口按批次限制最多 500 项；未配置密钥时禁用。设置密钥示例：

```bash
printf 'ERP_API_KEY=%s\n' "$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')" >> /etc/rentalcar.env
systemctl restart rentalcar
```

ERP 可访问稳定 API；要做生产系统对系统同步时，还应限制调用方网络来源并制定密钥轮换流程。
