# Rental Car 车辆共享看板

租车公司使用的多店铺车辆共享看板，整个项目使用 JavaScript/Node.js 24 开发。总店和每家加盟店都有各自独立的车辆、停车位置、地图导航链接和布局；店铺账号只能查看并操作本店数据，不能读取其他店铺的数据。现有总店数据升级时会保留并归入「本店」。

每家新店默认创建 13 个位置，分别是駐車場 1–9、「本店貸出中」、「駅前店貸出中」、「予備」和「立駐」。每个位置都可独立调整尺寸和排序；车辆可在本店位置之间拖放。新车默认放入「予備」。看板含车型颜色、车辆目录、洗车/加油/维修状态筛选，以及 ETC、车载器、禁烟/吸烟、导航和冬胎选项。管理员可自定义添加、删除対応ステータス；车辆状态筛选和 FOLLOW-UP 列表会在同店登录用户间实时同步。ステータス別の車両列表位于停车场上方，可折叠并限制展开高度。车辆和位置布局保存在 SQLite，并仅在同一家店的已登录用户之间实时同步。

各店管理员可点击「サイズ調整」并拖动把手调整位置大小，也可选择颜色后在位置内绘制直线、使用「取り消し」删除最后绘制的线，或选中并删除指定线条；线条会保存在数据库并同步给同店用户，切换到其他位置不会清除已保存的线条。拖动车辆到屏幕边缘时，看板会自动滚动，便于将车辆移到当前屏幕外的位置。拖动位置标题可重新排序，移动设备也可使用左右按钮排序。点击「＋ 位置を管理」可添加位置、修改名称、设置 Google 地图 HTTPS 导航链接或删除空位置；有车辆的位置必须先移动车辆才能删除，删除「予備」后，新车会默认放入当前排序最前的位置。操作账号可查看看板、移动及编辑本店现有车辆，但不能新增/删除车辆或更改位置。账号密码使用 scrypt 加盐哈希，不记录车辆移动审计历史。

总店管理员可以从页面顶部的「＋ 加盟店管理」创建加盟店及首个管理员账号。加盟店创建时会有独立的 13 个位置和空车辆列表；创建者设置加盟店名称、管理员用户名和初始密码，再把账号安全地交给店铺负责人。加盟店不续费时，总店可在同一管理页面点击「利用停止」，该店所有账号会立即无法继续访问；收到续费后点击「利用再開」。也可输入店名确认后永久删除加盟店及其账号、车辆和位置；删除后无法恢复。此版本由总店人工管理续费状态，不连接支付服务，也不自动判断付款。

手机页面会将停车位置切换为单列全宽布局，避免沿用桌面端的半宽布局造成可用空间浪费。

从旧版升级时会自动建立新增的租赁位置，并把旧「本店貸出中」、「駅前店貸出中」、「予備」分区的车辆分别迁入同名位置；车辆坐标、状态和装备选项保留。现有账号、位置和车辆全部归入「本店」总店租户；数据库迁移幂等，不会删除车辆。后续新加盟店不会继承总店的车辆、位置或导航链接。

ERP 后续可通过稳定的 `external_id` 和可选 API key 保护的同步接口接入；当前 ERP 同步接口仅同步总店租户，加盟店 ERP 接入需为每店增加独立的集成凭据和租户路由。ERP 同步车辆基础资料不会覆盖看板维护的状态和位置。

## 通过宝塔面板部署 (Debian 12)

本指南以只用 VPS 公网 IP、暂时不使用域名为例。网站和应用不需要 MySQL：程序使用 SQLite 文件。Node 应用只监听本机 `127.0.0.1:8000`，不要在防火墙开放 8000。

### 1. 安装宝塔和准备 VPS

正式使用前先准备一个指向 VPS 的域名，并在 VPS 服务商防火墙开放 TCP **22、80、443** 和受限访问的宝塔面板端口。不要把公网 IP 的 HTTP 登录页用于真实账号或车辆数据：HTTP 会明文传输密码和会话 Cookie。通过 SSH 登录 Debian 12 后，使用宝塔官网当前提供的 Debian 安装命令安装面板。

在宝塔左侧“软件商店”安装并启动 **Nginx**，再安装 **Node.js 版本管理器**并用它安装 **Node.js 24.x**。宝塔的 Node.js 版本管理器和 PM2 管理器插件可能互斥；本指南使用版本管理器随附的 `pm2` 命令，不要再安装 PM2 管理器。无需安装 Python、MySQL 或 Redis。

### 2. 添加网站并上传/克隆项目

在宝塔“网站”中添加站点：域名栏填写已解析到 VPS 的域名，目录使用默认值，PHP 选“纯静态/不使用 PHP”，数据库选“无/不创建”，FTP 不创建。网站目录仅作为 Nginx 入口；应用代码与数据库放在单独目录。

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
printf 'SESSION_SECRET=%s\nDATABASE_PATH=/www/wwwroot/rentalcar-data/rentalcar.db\nCOOKIE_SECURE=1\nERP_API_KEY=\n' "$SECRET" > .env
chown www:www /www/wwwroot/rentalcar-app/.env
chmod 600 /www/wwwroot/rentalcar-app/.env
su -s /bin/sh www -c 'cd /www/wwwroot/rentalcar-app && /www/server/nodejs/v24.21.0/bin/node app/create-admin.js'
```

按提示输入管理员用户名和密码。密码至少 12 个字符；输入时终端不显示字符是正常的。应用启动时会自动创建 SQLite 数据库和 13 个平级位置。再次运行最后一条管理员创建命令可添加其他账号。

创建不能新增、删除车辆或管理位置的普通操作账号（可查看看板、移动现有车辆及编辑车辆状态/资料），在宝塔终端执行以下命令两次；每次分别输入不同的用户名和密码：

```bash
su -s /bin/sh www -c 'export PATH=/www/server/nodejs/v24.21.0/bin:$PATH; cd /www/wwwroot/rentalcar-app && npm run create-operator'
```

该账号的页面不会显示车辆新增/删除或位置管理入口，服务端也会拒绝新增/删除车辆、创建/修改位置和调整位置顺序的请求。现有账号保持管理员权限；数据库会在更新后自动迁移，不需要重建账号或重启 VPS。

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

### 5. 配置 HTTPS 和宝塔反向代理

先在宝塔“网站”列表打开域名站点的“设置”→“SSL”，申请并启用有效的 HTTPS 证书。然后在“反向代理”→“添加反向代理”填写：

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

打开 `https://你的域名/api/me`，若显示 `{"authenticated":false}`，代表 HTTPS 入口和代理正常；首页应显示登录页面。Node 应用仍只监听本机 HTTP，TLS 由 Nginx 终止；不得向公网开放 8000 端口。

### 6. 登录验收与安全

通过 `https://你的域名` 登录并录入真实车辆。正式部署必须保持 `.env` 中 `COOKIE_SECURE=1`，这样登录会话 Cookie 仅通过 HTTPS 发送。若目前只有公网 IP、还没有域名与证书，请先不要录入正式密码或车辆资料；可先配置域名和 HTTPS，或仅通过 VPN/可信内网访问。宝塔面板端口也应限制为自己的 IP。

### 备份与快捷更新命令

数据库在 `/www/wwwroot/rentalcar-data/rentalcar.db`，不在公开的网站目录内。用宝塔计划任务定期备份此目录，并把副本保存到 VPS 以外。

首次设置一次即可：确认仓库已包含 `scripts/rental` 后，在宝塔终端以 root 运行下面命令。它安装一个 root 所有的全局命令入口；实际更新脚本以 `www` 用户运行，并随仓库更新，因此不会让 `www` 用户拥有 root 权限：

```bash
install -o root -g root -m 755 /www/wwwroot/rentalcar-app/scripts/rental-command /usr/local/bin/rental
```

此后每次更新只需在宝塔终端输入：

```bash
rental update
```

更新时脚本会检查本地代码是否干净、确认能安全快进到 `origin/main`，然后停止应用、检查点 SQLite WAL 并备份数据库、更新代码和生产依赖、重启 PM2，最后检查本机 HTTP 是否正常。若更新中途失败，会尝试重新启动应用；数据库备份保留在 `/www/wwwroot/rentalcar-data/`，不会自动删除。运行 `rental status` 可以查看服务状态。命令从 root 终端运行；正常情况无需再手动执行多条 `su` 或 Git 命令。

位置结构升级会由应用启动时自动迁移；脚本备份数据库，迁移不删除车辆。

当前单进程和 SQLite 适合单台 VPS 与约 250 台车。扩展到多进程/多服务器时，应改用共享数据库与消息通道。

### 常见部署问题

- **网站数据库选项**：选“无/不创建”。应用使用 SQLite 文件，不使用 MySQL。
- **`node: command not found`**：宝塔 Node 不一定在 root 的 PATH；使用 `/www/server/nodejs/v24.21.0/bin/node` 完整路径，并将该目录加入运行命令的 PATH。
- **`sudo: command not found`**：宝塔系统可能没有 sudo。用 `su -s /bin/sh www -c '命令'` 以 `www` 用户运行。
- **`Cannot find module 'dotenv'`**：依赖没有安装完整。先成功完成 `npm ci --omit=dev`，再创建管理员或启动应用。
- **npm cache `EACCES` / `root-owned files`**：不要以 root 和 `www` 混用 npm 缓存；按上文将项目归 `www` 所有，并指定 `/www/wwwroot/rentalcar-data/npm-cache`。
- **Node 版本管理器与 PM2 管理器互斥**：只用版本管理器附带的 PM2 命令。
- **`.env` 变量名里出现反斜线**：必须写作 `SESSION_SECRET`、`DATABASE_PATH`，不要写成 `SESSION\_SECRET`。复制上面的代码块可避免手动输入错误。
- **`/api/me` 能返回 JSON，但首页空白**：确认已更新到最新版本并检查浏览器控制台和 PM2 日志；正式部署必须使用 HTTPS 和 `COOKIE_SECURE=1`。本地 HTTP 开发才临时使用 `COOKIE_SECURE=0`。

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
