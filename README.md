# Rental Car 车辆共享看板

租车公司使用的共享看板，整个项目使用 JavaScript/Node.js 24 开发。支持两家门店、9 个停车区域、约 250 台共享车辆的登录看板，按车种着色、拖动车辆并保存位置、洗车/加油/维修状态筛选，以及 WebSocket 实时刷新。SQLite 保存车辆、账号及登录会话；密码用 scrypt 加盐哈希，不记录车辆移动审计历史。系统不会生成虚构车牌，请登录后录入实际车辆或接 ERP。

ERP 后续可通过稳定的 `external_id` 和可选 API key 保护的同步接口接入；ERP 同步车辆基础资料不会覆盖看板维护的状态和位置。

## 通过宝塔面板部署 (Debian 12)

以下使用示例域名 `board.example.com`。请先购买/准备域名，并将 DNS A 记录指向 VPS 公网 IP；后续操作中的域名、面板安全端口、管理员用户名按你的实际环境替换。

### 1. 安装宝塔和准备 VPS

在 VPS 服务商控制台的防火墙/安全组中先开放 TCP **22、80、443 和你自行设置的宝塔面板端口**。8000 端口不应向公网开放。

SSH 到 Debian 12 VPS，按宝塔官网“Linux 面板安装”页面为 Debian 提供的**最新官方命令**安装面板。安装命令会随面板版本变化，因此不要复制不明来源的旧安装脚本。安装后保存终端给出的面板地址、登录用户名和密码，并用浏览器登录；首次登录建议完成面板安全入口/端口设置。

在宝塔左侧“软件商店”安装并启动 **Nginx**。随后安装 **Node.js 版本管理器**（有些版本/插件页面会把它叫做 Node.js 版本管理器或 Node 项目管理器）；在插件里安装 **Node.js 24.x**。本项目需要 Node 24，因为数据库使用 Node 自带的 `node:sqlite`。如果插件把“版本管理”和“项目管理”拆成两个插件，请都安装。无需安装 Python、MySQL 或 Redis。

### 2. 添加网站并上传/克隆项目

在宝塔“网站”中添加站点：

- 域名：`board.example.com`
- 网站目录：使用宝塔建议的默认目录即可
- PHP 版本：纯静态/不使用 PHP（应用由 Node 运行）
- 数据库：不创建

部署代码时可在宝塔“终端”或 SSH 终端执行。先确认宝塔终端中能找到 Node.js 24：

```bash
node --version
npm --version
```

如果显示的 Node 不是 24.x，请在 Node.js 版本管理器中切换到 24.x，并按插件显示的 Node/npm 命令路径执行以下命令。PR 合并后从 `main` 获取代码：

```bash
git clone https://github.com/chiyamahisayoshi/rentalcar.git /www/wwwroot/rentalcar-app
cd /www/wwwroot/rentalcar-app
npm ci --omit=dev
```

如果代码还没有合并到 `main`，暂时测试 PR 的话把 clone 命令改为：

```bash
git clone --branch chiyamahisayoshi-rentalcar-live-board https://github.com/chiyamahisayoshi/rentalcar.git /www/wwwroot/rentalcar-app
```

私有仓库请使用只读 Deploy Key 或面板/服务器已配置的 Git 凭据；不要把 GitHub Token 写在命令、网页文件或截图中。

创建数据库目录并设置宝塔网站常用的运行用户 `www` 可读写：

```bash
mkdir -p /www/wwwroot/rentalcar-data
chown -R www:www /www/wwwroot/rentalcar-data
chmod 750 /www/wwwroot/rentalcar-data
chown -R www:www /www/wwwroot/rentalcar-app
```

如果你的宝塔系统使用了不同的站点运行用户，请将 `www:www` 换成面板显示的实际用户和组。

### 3. 建立环境配置并创建管理员账号

在宝塔“文件”中新建 `/www/wwwroot/rentalcar-app/.env`。先在宝塔“终端”运行以下命令生成随机会话密钥：

```bash
node -e 'console.log(require("node:crypto").randomBytes(48).toString("base64url"))'
```

将生成的值填入 `.env`，不要把密钥发送给别人或提交到 Git：

```dotenv
SESSION_SECRET=替换为刚生成的随机密钥
DATABASE_PATH=/www/wwwroot/rentalcar-data/rentalcar.db
COOKIE_SECURE=1
# ERP 尚未对接时留空；启用时换成另一条独立的随机密钥
ERP_API_KEY=
```

保护配置文件并创建首个管理员账号。下面假设宝塔运行用户是 `www`：

```bash
chown www:www /www/wwwroot/rentalcar-app/.env
chmod 600 /www/wwwroot/rentalcar-app/.env
cd /www/wwwroot/rentalcar-app
sudo -u www node app/create-admin.js
```

命令会从 `.env` 读取数据库位置，并在终端中隐藏管理员密码输入。密码至少 12 个字符，请用密码管理器保存。再次运行命令可增加其他唯一用户名的操作员。应用首次运行时会自动创建数据库及 9 个停车区域。

### 4. 用宝塔 Node.js 项目管理器启动应用

打开宝塔左侧“软件商店”安装的 **Node.js 项目管理器**，添加 Node 项目。不同宝塔/插件版本字段名称可能略有差别，按下面值填写：

| 项目设置 | 值 |
| --- | --- |
| 项目名称 | `rentalcar` |
| 项目路径 / 项目目录 | `/www/wwwroot/rentalcar-app` |
| 启动文件 | `app/server.js` |
| Node 版本 | `24.x` |
| 启动模式 | 正式 / production |
| 监听地址 | `127.0.0.1`（若插件只有端口设置，应用本身默认绑定 `127.0.0.1`） |
| 项目端口 | `8000` |

依赖已在前一步用 `npm ci --omit=dev` 安装。项目启动后，在宝塔“终端”验证：

```bash
curl -I http://127.0.0.1:8000/
```

看到 `HTTP/1.1 200 OK` 即表示 Node 应用已启动。宝塔 Node 项目管理器需要保持**单个应用进程/一个 worker**；实时 WebSocket 通知依赖同一 Node 进程内的连接状态。若启动失败，先检查插件的项目日志、Node 24 是否生效、`.env` 权限及 `DATABASE_PATH` 的目录权限。

### 5. 在宝塔网站设置反向代理、WebSocket 和 HTTPS

回到宝塔“网站”列表，打开 `board.example.com` 的“设置”：

1. 在“反向代理”中新增代理，名称如 `rentalcar-node`，目标 URL 填 `http://127.0.0.1:8000`，发送域名选择 `$host`/当前站点域名。
2. 开启该代理项的 **WebSocket 支持**（如果显示为 WebSocket 反向代理或 WebSocket 转发，也要开启）。这是多人实时同步必需的。
3. 在“SSL”中选择 Let’s Encrypt，勾选该域名并申请证书；签发成功后开启“强制 HTTPS”。

申请证书前，请确认 DNS 已生效，云防火墙和宝塔“安全”中都开放 TCP 80、443。不要再为网站配置 PHP，也不要把 8000 加进公网防火墙规则。生产 `.env` 的 `COOKIE_SECURE=1` 需要与 HTTPS 同时使用。

### 6. 登录验收和录入车辆

浏览器访问 `https://board.example.com`，用刚创建的账号登录，然后录入真实车辆。建议用两个浏览器同时登录，测试添加/编辑车辆、拖到其他停车区、洗车/给油/修理状态筛选，确认另一浏览器能实时更新。

### 备份与更新

车辆、用户和会话数据库在 `/www/wwwroot/rentalcar-data/rentalcar.db`，不在公开的网站目录内。可在宝塔计划任务设置每日备份，将以下命令的备份目标改到另一个磁盘/远端存储；备份应限制访问并定期复制到 VPS 以外：

```bash
sudo -u www node -e '
const { DatabaseSync, backup } = require("node:sqlite");
const source = new DatabaseSync("/www/wwwroot/rentalcar-data/rentalcar.db", { readOnly: true });
backup(source, "/www/wwwroot/rentalcar-data/backup.db")
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => source.close());'
```

更新前先备份。在宝塔终端运行 `git pull --ff-only` 与 `npm ci --omit=dev`，再到 Node.js 项目管理器重启 `rentalcar` 项目。若程序或项目设置在更新后发生变化，检查 Node 项目管理器日志。Node 项目只监听 VPS 本机；当前单进程和 SQLite 适合一台 VPS 与约 250 台车。将来扩容到多个应用进程/服务器时，应改用共享数据库与消息通道。

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

在 `.env` 配置 `ERP_API_KEY` 后，ERP 使用 `POST /api/integration/vehicles:sync`，并在 `X-ERP-API-Key` 请求头发送密钥。请求 JSON 为数组，每项包含 `external_id`、`plate`、`vehicle_type`，以及可选 `parking_lot_id`。相同 `external_id` 重复同步时会更新基础车辆资料，但不覆盖看板状态和位置；每批最多 500 台。未设置密钥时接口返回 503。密钥更新后在宝塔 Node.js 项目管理器重启项目。
