# 个人导航站 · 主页直接编辑版

保留原有导航主页的样式和链接，管理员登录后可以直接在主页修改内容。

## 功能

- 网站名称、网址和图标的新增、修改、删除。
- 网址支持端口和路径；内网地址可用 `{host}` 占位符代替主机名（如 `http://{host}:9999/ui`），打开页面时自动替换为当前主页的主机名，NAS 换 IP 无需改链接。
- 使用现有图标，或上传 PNG、JPG、WebP、GIF、ICO、SVG 图片。
- 分类新增、改名、删除，网站可移动到其他分类。
- 网站和分类拖动排序，也支持上下移动按钮。
- 配置保存在服务器，其他设备刷新即可看到最新内容。
- 深色模式、手机布局，百度回车搜索和 Google Alt+回车搜索。

## 部署（3 步）

使用 **Nginx + PHP 8.1 或以上**，无需数据库、构建、安装密钥和额外 Nginx 配置。

1. 将网站文件上传至服务器目录。
2. 给 PHP 用户 `storage/` 的写权限：`chown -R www:www storage && chmod 750 storage`。
3. 打开主页 → 右上角「管理」（平时隐藏，鼠标移到右上角显示；触屏设备不提供管理入口）→ 直接设置管理员密码（至少 6 个字符）。

没有默认密码，部署完成后请立即设置。忘记密码时把 `api.php` 顶部的 `PASSWORD_RESET` 临时改为 `true` 重新设置。完整说明见 [部署说明.md](部署说明.md)。

也可以不依赖 NAS，部署到 Cloudflare：**Workers + KV 移植版**（功能对等，同一套前端自动适配）或 **Cloudflare Tunnel**（保留 PHP 现状），二选一的操作步骤见 [Cloudflare部署说明.md](Cloudflare部署说明.md)。

## 目录

```text
index.html          主页及编辑窗口
js/main.js          展示、编辑和排序交互
css/style.css       样式及编辑界面
api.php             登录、保存、上传接口（顶部含密码重置开关）
links/default.json    首次打开时导入的初始内容，与保存后的数据同格式，可手工编辑（清空为 [] 即空白开局）
img/icons/          原有图标
storage/            私有数据，需要 PHP 写权限：
                    site.php 主页配置、admin.php 密码哈希、
                    backup.php 保存前自动备份、icons/ 新上传图标（原文件名-上传时间）
workers/worker.js   Cloudflare Workers 版后端（与 api.php 功能对等，数据存 KV）
wrangler.toml       Workers 部署配置；.assetsignore 控制不公开的文件
部署说明.md          安装、使用和维护说明（Nginx + PHP）
Cloudflare部署说明.md  Workers+KV 与 Tunnel 两种 CF 部署路线
```

升级时不要覆盖服务器上的 `storage/`。完整备份应包含整个网站目录。旧版的 `config.php`、`img/uploads/`、`storage/backups/` 和 `links/` 下的 6 个分文件（已合并为 `links/default.json`）已不再使用，可删除；旧配置引用的 `img/uploads/` 图标仍兼容显示。
