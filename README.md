# Rental Car 车辆共享看板

租车公司使用的共享看板，整个项目使用 JavaScript/Node.js 24 开发。包含“本店貸出中”“駅前店貸出中”“予備”三个停车场式分区，每个分区展示全部 9 个可调整大小、可拖动排序的停车场；车辆可在任意分区的任意停车场自由拖放。布局变化通过 SQLite 保存并实时同步到所有用户。系统另含按车型着色的车辆目录、洗车/加油/维修状态筛选，以及 ETC、车载器、禁烟/吸烟、导航和冬胎选项。新车默认放入“予備”的未配置区域。账号使用 scrypt 加盐密码哈希，不记录车辆移动审计历史；不生成虚构车牌，请登录后录入实际车辆或接 ERP。

停车场卡片点“尺寸”后可用 `−` / `+` 调高度，用“宽/窄”切换列宽。拖动停车场标题可重新排序；移动设备可点“尺寸”后用左右箭头排序。停车场布局保存在服务端，所有登录用户看到相同布局。

ERP 后续可通过稳定的 `external_id` 和可选 API key 保护的同步接口接入；ERP 同步车辆基础资料不会覆盖看板维护的状态和位置。

## 通过宝塔面板部署 (Debian 12)

本指南以只用 VPS 公网 IP、暂时不使用域名为例。网站和应用不需要 MySQL：程序使用 SQLite 文件。Node 应用只监听本机 `127.0.0.1:8000`，不要在防火墙开放 8000。

### 1. 安装宝塔和准备 VPS

在 VPS 服务商防火墙开放 TCP **22、80** 和宝塔面板端口。通过 SSH 登录 Debian 12 后，使用宝塔官网当前提供的 Debian 安装命令安装面板。

在宝塔左侧“软件商店”安装并启动 **Nginx**，再安装 **Node.js 版本管理器**并用它安装 **Node.js 24.x**。宝塔的 Node.js 版本管理器和 PM2 管理器插件可能互斥；本指南使用版本管理器随附的 `pm2` 命令，不要再安装 PM2 管理器。无需安装 Python、MySQL 或 Redis。

### 2. 添加网站并上传/克隆项目

在宝塔“网站”中添加站点：域名栏填写 VPS 公网 IP（例如 `43.133.161.210`），目录使用默认值，PHP 选“纯静态/不使用 PHP”，数据库选“无/不创建”，FTP 不创建。网站目录仅作为 Nginx 入口；应用代码与数据库放在单独目录。

以下命令假设 Node 版本管理器安装路径为 `/www/server/nodejs/v24.21.0`，应用运行用户为宝塔常见的 `www`。如果实际安装路径或用户不同，请替换为面板显示的值。PR 合并后从 `main` 获取代码：

```bash
git clone https://github.com/chiyamahisayoshi/rentalcar.git /www/wwwroot/rentalcar-app
mkdir -p /www/wwwroot/rentalcar-data
chown -R www:www /www/wwwroot/rentalcar-app /www/wwwroot/rentalcar-data
chmod 750 /www/wwwroot/rentalcar-data
```

PR 尚未合并到 `main`、需要测试当前 PR 时，用下面命令代替上面的 `git clone` 命令：

```bash
git clone --branch chiyamahisayoshi-rentalcar-live-board --single-branch https://github.com/chiyamahisayoshi/rentalcar.git /www/wwwroot/rentalcar-app
```

以 `www` 用户安装依赖，并使用独立 npm 缓存目录，避免 root 与 `www` 混用 npm 后产生缓存权限错误：

```bash
mkdir -p /www/wwwroot/rentalcar-data/npm-cache
chown -R www:www /www/wwwroot/rentalcar-app /www/wwwroot/rentalcar-data
su -s /bin/sh www -c 'export PATH=/www/server/nodejs/v24.21.0/bin:$PATH; cd /www/wwwroot/rentalcar-app && npm ci --omit=dev --cache /www/wwwroot/rentalcar-data/npm-cache'
```

只有看到 `added ... packages` 且没有 `npm error` 才继续。npm 若显示 `Unknown global config "--init.module"` 警告但安装成功，可以暂时忽略。

### 3. 建立环境配置并创建管理员账号

下面整段命令会生成随机会话密钥、写好 `.env`，并启动管理员创建提示。不要把 `.env` 内容或管理员密码发给别人。

```bash
cd /www/wwwroot/rentalcar-app
NODE=/www/server/nodejs/v24.21.0/bin/node
SECRET=$("$NODE" -e 'console.log(require("node:crypto").randomBytes(48).toString("base64url"))')
printf 'SESSION_SECRET=%s\nDATABASE_PATH=/www/wwwroot/rentalcar-data/rentalcar.db\nCOOKIE_SECURE=0\nERP_API_KEY=\n' "$SECRET" > .env
chown www:www /www/wwwroot/rentalcar-app/.env
chmod 600 /www/wwwroot/rentalcar-app/.env
su -s /bin/sh www -c 'cd /www/wwwroot/rentalcar-app && /www/server/nodejs/v24.21.0/bin/node app/create-admin.js'
```

按提示输入管理员用户名和密码。密码至少 12 个字符；输入时终端不显示字符是正常的。应用启动时会自动创建 SQLite 数据库和 9 个停车区域。再次运行最后一条管理员创建命令可添加其他账号。

### 4. 用 PM2 启动应用

使用 Node.js 版本管理器随附的 PM2 命令启动单个进程；不要额外安装可能互斥的 PM2 管理器插件：

```bash
su -s /bin/sh www -c 'export PATH=/www/server/nodejs/v24.21.0/bin:$PATH; export PM2_HOME=/www/wwwroot/rentalcar-data/.pm2; cd /www/wwwroot/rentalcar-app && pm2 start app/server.js --name rentalcar --interpreter /www/server/nodejs/v24.21.0/bin/node'
```

运行 `curl -I http://127.0.0.1:8000/`，看到 `HTTP/1.1 200 OK` 表示程序已启动。然后保存 PM2 进程清单：

```bash
su -s /bin/sh www -c 'export PATH=/www/server/nodejs/v24.21.0/bin:$PATH; export PM2_HOME=/www/wwwroot/rentalcar-data/.pm2; pm2 save'
```

如需 VPS 重启后自动启动，在宝塔“计划任务”新增启动时执行的 Shell 任务，命令为：

```bash
su -s /bin/sh www -c 'export PATH=/www/server/nodejs/v24.21.0/bin:$PATH; export PM2_HOME=/www/wwwroot/rentalcar-data/.pm2; pm2 resurrect'
```

保持单进程；WebSocket 实时刷新依赖同一个应用进程。

### 5. 在宝塔网站设置反向代理

在宝塔“网站”列表打开 IP 站点的“设置”→“反向代理”→“添加反向代理”，填写：

| 页面项目 | 填写内容 |
| --- | --- |
| 代理名称 | `rentalcar` |
| 目标 URL | `http://127.0.0.1:8000` |
| 发送域名 | `$host` |
| 开启代理 | 开 |
| 开启缓存 | 关 |
| 内容替换 | 留空 |

保存后确认代理状态是“运行中”。如果页面没有 WebSocket 开关，打开代理的“配置文件”，在 `location /` 代理配置块中确认有以下三行；已有就不要重复添加：

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
```

访问 `http://你的VPS公网IP`。打开 `/api/me` 若显示 `{"authenticated":false}`，代表入口和代理正常；首页应显示登录页面。

### 6. 登录验收与 HTTP 安全

用刚创建的账号登录，然后录入真实车辆。仅 IP 的 HTTP 访问不会加密登录密码，建议只在可信网络使用。HTTP 模式 `.env` 必须是 `COOKIE_SECURE=0`；若以后启用 HTTPS，再改成 `COOKIE_SECURE=1` 并重启应用。不要公开应用 8000 端口；宝塔面板端口最好限制为自己的 IP。

### 备份与更新

数据库在 `/www/wwwroot/rentalcar-data/rentalcar.db`，不在公开的网站目录内。用宝塔计划任务定期备份此目录，并把副本保存到 VPS 以外。

更新前先备份。在宝塔终端运行：

```bash
su -s /bin/sh www -c 'export PATH=/www/server/nodejs/v24.21.0/bin:$PATH; export PM2_HOME=/www/wwwroot/rentalcar-data/.pm2; cd /www/wwwroot/rentalcar-app && git pull --ff-only && npm ci --omit=dev --cache /www/wwwroot/rentalcar-data/npm-cache && pm2 restart rentalcar'
```

当前单进程和 SQLite 适合单台 VPS 与约 250 台车。扩展到多进程/多服务器时，应改用共享数据库与消息通道。

### 常见部署问题

- **网站数据库选项**：选“无/不创建”。应用使用 SQLite 文件，不使用 MySQL。
- **`node: command not found`**：宝塔 Node 不一定在 root 的 PATH；使用 `/www/server/nodejs/v24.21.0/bin/node` 完整路径，并将该目录加入运行命令的 PATH。
- **`sudo: command not found`**：宝塔系统可能没有 sudo。用 `su -s /bin/sh www -c '命令'` 以 `www` 用户运行。
- **`Cannot find module 'dotenv'`**：依赖没有安装完整。先成功完成 `npm ci --omit=dev`，再创建管理员或启动应用。
- **npm cache `EACCES` / `root-owned files`**：不要以 root 和 `www` 混用 npm 缓存；按上文将项目归 `www` 所有，并指定 `/www/wwwroot/rentalcar-data/npm-cache`。
- **Node 版本管理器与 PM2 管理器互斥**：只用版本管理器附带的 PM2 命令。
- **`.env` 变量名里出现反斜线**：必须写作 `SESSION_SECRET`、`DATABASE_PATH`，不要写成 `SESSION\_SECRET`。复制上面的代码块可避免手动输入错误。
- **`/api/me` 能返回 JSON，但首页空白**：更新到修复 HTTP 安全策略的版本；纯 HTTP 使用 `COOKIE_SECURE=0`。

## 本地开发和测试

安装 Node.js 24 或更新版本：

```bash
npm ci
export SESSION_SECRET="$(node -e 'console.log(require("node:crypto").randomBytes(48).toString("base64url"))')"
npm run create-admin
npm start
```

浏览器打开 `http://127.0.0.1:8000`；运行 `npm test` 执行自动化测试。`SESSION_SECRET` 是启动必需项，开发时 `COOKIE_SECURE` 可设为 `0`。整个应用不需要 Python。

## ERP 同步接口

在 `.env` 配置 `ERP_API_KEY` 后，ERP 使用 `POST /api/integration/vehicles:sync`，并在 `X-ERP-API-Key` 请求头发送密钥。请求 JSON 为数组，每项包含 `external_id`、`plate`、`vehicle_type`，以及可选 `parking_lot_id`。相同 `external_id` 重复同步时会更新基础车辆资料，但不覆盖看板状态和位置；每批最多 500 台。未设置密钥时接口返回 503。密钥更新后通过 PM2 重启应用。
