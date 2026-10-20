# Cloudflare 部署说明

本项目有两套后端、同一套前端（`js/main.js` 不区分后端）：

| | A. Workers + KV | B. Cloudflare Tunnel |
|---|---|---|
| 形态 | 纯云部署，**不再依赖 NAS** | NAS 照旧跑 nginx+php，CF 只做入口 |
| 存储 | Cloudflare KV | NAS 上的 `storage/` 文件 |
| 改动量 | 零改造，按本文操作 | 零代码改动 |
| NAS 关机后 | 主页仍在线（内网服务链接自然不通） | 离线 |
| 适合 | 想要「像以前托管静态站一样」随时改随时发 | 想保留现有 PHP 环境与数据 |

两条路线都解决「公网访问 + IP 变化」问题，且都在 Cloudflare 免费额度内。以下分节操作。

---

## A. Workers + KV 部署（推荐，脱离 NAS）

### A0 先读：哪些操作能在网页端完成？

| 操作 | 网页端 | 说明 |
|---|---|---|
| `npx wrangler login` 授权 | ✅ | 它本身就是跳浏览器网页授权，只在跑命令时发生一次 |
| 创建/编辑 Worker 代码 | ✅ | Workers & Pages → Create → 用在线编辑器粘贴 [workers/worker.js](workers/worker.js) 源码，Deploy 即发布 |
| 创建 KV 命名空间、录入键值 | ✅ | [KV 页面](https://developers.cloudflare.com/kv/get-started/)可新建命名空间、Add entry 录入 `site`/`admin` 等文本 JSON（见 A7） |
| 绑定 KV、设置 `PASSWORD_RESET` 变量 | ✅ | Worker → Settings → Bindings / Variables |
| 绑定自定义域名、看日志、回滚 | ✅ | 全部在 Dashboard |
| **上传静态资源目录**（index.html、css、js、img/、links/） | ❌ | 在线编辑器只能改 Worker 源码，**没有「上传文件夹」功能** |
| 二进制图标批量导入 KV | ❌（不适合） | 网页只能逐条贴文本，图片没法贴 |

**结论**：Worker、KV、域名、密码开关都能纯网页操作；**堵点只有静态资源目录**。推荐两种绕过方式：

**方式一（最推荐）：GitHub 自动构建，之后全程网页**
[Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/) 是 CF 官方的 Git 集成：Dashboard → Workers & Pages → Create → **Connect to Git** → 授权并选择你的仓库 → 构建配置指向仓库里的 `wrangler.toml`（构建目录 = 仓库根目录，无构建命令）。之后**每次 `git push` 自动部署**——静态资源、Worker 源码、KV 绑定全部按 `wrangler.toml` 生效，本地一条 `npx` 都不用再跑。
前置：先在网页 KV 页建好命名空间、把 id 填进 `wrangler.toml` 并推送到仓库（A3 里 id 的获取和填写都可在网页完成）。

**方式二：三条命令跑一次，后续日常操作全在网页**
A2-A4 一共三条命令，跑完之后：改数据（KV 网页）、改密码开关（Variables 网页）、绑域名（网页）、看日志（网页）都不再碰终端；只有**改代码/样式**时才需要重跑一次 `npx wrangler deploy`（或者切到方式一就连这步也省了）。

纯在线编辑器手贴所有文件**不可行**（静态资源没有上传入口），请不要在这条路上浪费时间。

### A0.1 纯网页部署清单（有 GitHub 仓库 + 走方式一）

KV 完全可以靠网页实现，按顺序点下来即可，全程不需要终端（A2-A4 的命令在方式一下整段跳过）：

1. **建 KV 命名空间（CF 网页）**：Dashboard → Workers & Pages → **KV**（或 Storage & Databases → Workers KV）→ Create namespace，名称如 `home_nav` → 在命名空间列表**复制生成的 id**（32 位十六进制）。
2. **把 id 写进 wrangler.toml（GitHub 网页）**：仓库中打开 `wrangler.toml` → 点右上角铅笔图标在线编辑 → 粘贴 id 到 `[[kv_namespaces]]` 的 `id = "..."` → Commit changes。
3. **接入仓库（CF 网页）**：Workers & Pages → Create application → **Connect to Git** → 授权 GitHub 并选择该仓库 → 构建配置：构建命令留空、以仓库根目录的 `wrangler.toml` 为准 → Deploy。此后每次 `git push` 自动部署。
4. **核对绑定（CF 网页）**：Worker → Settings → Bindings 里应出现 `NAV`（KV namespace，由 wrangler.toml 自动创建）。若没有：手动 Add → KV namespace → 选中第 1 步的命名空间，**变量名必须是 `NAV`**。
5. **设置密码（页面操作）**：打开部署地址 → 右上角「管理」→ 设置密码——这一步会在 KV 自动写入 `admin` 键，无需手建。
6. **（可选）从 NAS 迁移数据（KV 网页）**：KV → `home_nav` → **Add entry**：
   - key 填 `site`，value 粘贴 `storage/site.php` **去掉第一行 PHP 保护前缀后**的 JSON（用 GitHub 网页编辑器打开该文件、删掉首行、复制即可）；
   - 老的上传图标是二进制，网页贴不了：部署后在主页「编辑 → 上传图标」重传即可，不传的会自动回退默认图标。
7. **日常维护（全部 CF 网页）**：改主页数据 → KV 页面 Add/Edit entry；忘记密码 → Settings → Variables 把 `PASSWORD_RESET` 改 `"true"` 部署 → 重设密码 → 改回；改代码/样式 → GitHub 网页编辑 → push → 自动构建上线。

`session:*`、`attempt:*`、`icon:*` 键由运行时自动生成，**不要**在网页里手建。GitHub 仓库公开与否均无密钥泄露风险（仓库不含任何令牌，KV id 单独暴露无用）。

### A1 前置条件

- Cloudflare 免费账号（https://dash.cloudflare.com 注册）
- 本机有 Node.js 18+（`node -v` 检查）
- 在项目根目录打开终端（能看到 `wrangler.toml`）

### A2 登录 wrangler

```bash
npx wrangler login
```

浏览器完成授权（首次会自动下载 wrangler，无需全局安装）。

### A3 创建 KV 命名空间

```bash
npx wrangler kv namespace create NAV
```

把输出中的 `id`（32 位十六进制）粘贴进 [wrangler.toml](wrangler.toml)：

```toml
[[kv_namespaces]]
binding = "NAV"
id = "这里粘贴输出的 id"
```

> 若 wrangler 提示子命令已更名（v3/v4 有差异），按它给出的命令执行即可，作用相同。
> **已有数据的命名空间 id 不要再改**，否则会连不上已有数据。

### A4 部署

```bash
npx wrangler deploy
```

成功后输出 `https://home-nav.<你的子域>.workers.dev`，即为你的新主页地址。

### A5 首次设置密码

打开输出的 https 地址 → 右上角「管理」→ 直接设置密码（与 NAS 版没有默认密码的规则一致，**部署完立即设置**）。

注意：Workers 版与 NAS 版的密码**各自独立存储**（算法不同，不可互相迁移）；两边都要用的话各设置一次即可，可以设成相同密码。

### A6 访问地址与 `{host}` 占位符（重要）

| 部署形态 | `{host}` 解析结果 | 内网服务链接建议 |
|---|---|---|
| `workers.dev` 域名 | workers.dev 主机名 | **不要用 `{host}`**：内网服务请直接写 `http://home.lishx.dpdns.org:9999/ui` 这样的固定域名或 IP |
| 自定义域名托管在 CF | 该域名 | 与 NAS 版行为完全一致，放心用 `{host}` |

绑定自定义域名（可选）：域名的 DNS 区需托管在同一个 CF 账号 → Workers & Pages → home-nav → Settings → **Domains & Routes** → Add Custom Domain。

> 始终通过 **https://** 访问：登录用的 PBKDF2 依赖浏览器安全上下文（http 下 `crypto.subtle` 不可用，登录会被拒绝）。workers.dev 默认可用 https。

### A7 从 NAS 迁移已有数据（可选）

- **主页配置**：`storage/site.php` 第一行是 PHP 保护前缀，去掉后就是与 KV 兼容的 JSON：

  ```bash
  tail -n +2 storage/site.php > site.json
  npx wrangler kv key put site --path site.json --binding NAV --remote
  ```

  也可以在 CF 面板（Workers & Pages → KV → 你的命名空间 → Add entry）手动粘贴，key 填 `site`。
- **上传过的图标**：key 为 `icon:<文件名>`，逐个用 `npx wrangler kv key put "icon:名字.png" --path 本地图标 --binding NAV --remote` 迁移；嫌麻烦就直接在新主页重传，旧链接会自动回退默认图标。
- **密码**：无法迁移，按 A5 单独设置。
- 不迁移也行：首次访问会自动导入 `links/default.json` 初始内容（与 NAS 版一致）。

### A8 日常更新与备份

- **更新**：改完代码/样式/文档后在项目根目录执行 `npx wrangler deploy`，静态资源随 Worker 一起发布，没有单独的「传文件」步骤。
- **备份配置**：`npx wrangler kv key get site --binding NAV --remote > site-backup.json`；恢复用 `key put` 反向操作。
- **忘记密码**：把 [wrangler.toml](wrangler.toml) 里 `[vars] PASSWORD_RESET` 改为 `"true"` → deploy → 回主页重新设置 → 改回 `"false"` 再 deploy。

### A9 免费额度（个人主页远用不完）

Workers：10 万请求/天；KV：10 万读 + 1000 写/天、单值 25MB（图标限 2MB）。

### A10 与 NAS 版差异对照

| 项目 | NAS（nginx+php） | Workers 版 |
|---|---|---|
| 登录密码存储 | bcrypt（明文字段走 TLS） | 浏览器端 PBKDF2-SHA256×60 万次的派生值；**登录多等约半秒**，离线爆破成本等价 |
| 会话 / CSRF / 登录限速 / 保存前自动备份 | 有 | 有（会话存 KV，TTL 2 小时，语义一致） |
| 图标上传校验 | 完整（含 4096px 尺寸） | 魔数嗅探（PNG/GIF/ICO 限尺寸，JPEG/WEBP 不解析尺寸） |
| 数据一致性 | 文件锁强一致 | KV 最终一致：保存后异地节点最长约 1 分钟看到新配置 |
| 忘记密码 | api.php 顶部常量 | wrangler.toml 的 `PASSWORD_RESET` 变量 |
| 时间戳 | Asia/Shanghai | 同为北京时间 |

`site`/`backup` 数据格式与 NAS 版完全相同，两套后端可随时互迁（A7）。

---

## B. Cloudflare Tunnel 部署（保留 PHP 的备选）

适合想让 NAS 版原样运行、只是需要安全公网入口的场景：不需要公网 IP、不开任何端口、宽带换 IP 无影响，nginx 与 `storage/` 一切照旧。

### B1 创建隧道（Cloudflare 面板 + Docker，适配飞牛 fnOS 等面板 NAS）

1. CF 面板 → **Networks → Tunnels** → Create a tunnel → 类型选 **Cloudflared** → 起个名字（如 `nas-home`）。
2. 下一页面板会给出带 token 的启动命令，其中 Docker 形式为：

   ```yaml
   # docker-compose.yml
   services:
     cloudflared:
       image: cloudflare/cloudflared:latest
       container_name: cloudflared
       command: tunnel --no-autoupdate run --token <面板给你的TOKEN>
       restart: unless-stopped
   ```

   `docker compose up -d` 启动（镜像拉取需要容器出网）。
3. 同一页 **Public Hostnames** 添加路由：

   ```text
   域名: home.你的域名（如 home.example.com）
   服务: http://<NAS内网IP>:80     ← 指向现有 nginx
   ```

   DNS 记录由面板自动写入（域名需托管在该 CF 账号下）。
4. 完成后 `https://home.你的域名` 即为首页地址，**nginx、PHP、storage、密码全部不变**；`{host}` 占位符解析为该域名，内网服务链接照常跟随。

### B2 使用要点

- 访问链路：浏览器 → CF 边缘 → 隧道 → NAS nginx，NAS 无需公网 IP、无需端口映射，换宽带/换 IP 无感。
- 后台管理仍是应用自身的密码；可叠加 **Cloudflare Access**（Zero Trust）给整站再加一层邮箱验证码。
- NAS 关机则整站离线（这是与 A 路线的本质区别）。

---

## FAQ

- **两套可以同时用吗？** 可以，不同地址、各自独立的数据与密码；主用哪套就把哪个地址当日常入口。数据格式相同，可用 A7 双向迁移。
- **部署后页面是旧的？** Workers 的静态资源随 `wrangler deploy` 发布，浏览器强刷即可；`.assetsignore` 里排除的文件（api.php、storage、workers/、*.md 等）不会被上传，属正常现象。
- **wrangler 命令提示废弃/改名？** 按它输出的新命令执行，语义相同。
- **本地怎么预览？** 静态部分 `php -S 127.0.0.1:8080`（或任意静态服务器）可看页面，但 API 需要真实后端：用 `npx wrangler dev` 本地跑 Worker（需已按 A3 配好 KV，本地开发用远端 KV：`wrangler dev --remote`）。
