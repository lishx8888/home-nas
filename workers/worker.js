// Cloudflare Workers 版主页 API —— 与仓库根目录 api.php 功能对等，前端 js/main.js 无需区分后端。
//
// 存储映射（KV binding 名 NAV，见 wrangler.toml）：
//   site        主页配置 { updatedAt, categories }，与 storage/site.php 内容一致（去掉 PHP 前缀即可迁移）
//   backup      每次保存前的自动备份 { backedUpAt, site }（单份，与 storage/backup.php 语义一致）
//   admin       管理员 { derived, createdAt }，derived 为浏览器端 PBKDF2-SHA256 派生值（64 位十六进制）
//   session:*   登录会话 { admin, csrf, last }，TTL 2 小时，对应 PHP 的 session
//   attempt:*   登录失败计数 { since, count }，TTL 15 分钟，对应 storage/attempts.php
//   icon:*      上传图标（字节 + contentType 元数据），对应 storage/icons/
//
// 密码方案说明：Workers 免费版单请求 CPU 上限约 10ms，服务端跑 PBKDF2 必超限，因此
// 派生在浏览器完成（js/main.js 的 deriveKey），服务端只存/比对派生值——离线爆破仍需
// 对每个猜测重跑 60 万次 PBKDF2，安全性与服务端 PBKDF2 等价；传输仍走 HTTPS。
// NAS 版 api.php 同时收到明文 password 字段（保持 bcrypt 流程不变），两个后端共用同一前端。

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store, private, max-age=0', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' };
const SESSION_TTL = 7200;      // 会话有效期（秒），与 PHP 版一致
const ATTEMPT_WINDOW = 900;    // 登录限速窗口（秒）
const MAX_ATTEMPTS = 8;        // 窗口内最大失败次数
const BODY_LIMIT = 1048576;    // 请求体上限 1MB
const PASSWORD_RESET = 'false'; // 忘记密码时临时改为 'true'，重设后改回（对应 api.php 的常量）

// img/icons/ 下随仓库发布的图标清单（静态资源无目录列表功能，这里维护清单供 icons 接口返回）
const BUILTIN_ICONS = [
  '1688.png', '1900.png', '2wm.ico', '51nb.ico', '52pj.svg', 'blog.png', 'csdn.ico',
  'default.svg', 'douyin.png', 'easychuan.png', 'fnos.ico', 'gemini.svg', 'github.png',
  'goofish.png', 'grok.png', 'hd9901.png', 'hs530r.png', 'jd.ico',
  'libretv.png', 'mthink.ico', 'oec.png', 'segmentfault.ico', 'sina.svg', 'solara.svg',
  'taobao.png', 'tencent.png', 'tg.ico', 'weibo.ico', 'wenxin.png', 'zhihu.ico'
];

const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', ico: 'image/x-icon', svg: 'image/svg+xml' };

function respond(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } });
}
function fail(message, status = 400) { return respond({ error: message }, status); }
function isList(value) { return Array.isArray(value); } // JSON 解析后：数组即列表
function codePoints(value) { return [...value].length; }

async function sha256hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function randHex(bytes) { return [...crypto.getRandomValues(new Uint8Array(bytes))].map(b => b.toString(16).padStart(2, '0')).join(''); }
// 常量时间比较，避免时序侧信道
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function validId(value) { return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value); }
function textValue(value, maximum, field) {
  if (typeof value !== 'string') return fail(field + '格式不正确。');
  const trimmed = value.trim();
  if (codePoints(trimmed) === 0 || codePoints(trimmed) > maximum || /[\x00-\x1F\x7F]/.test(trimmed)) return fail(field + '为空、过长或含无效字符。');
  return trimmed;
}
// 与 api.php validIcon 相同的三种图标路径格式（纯格式校验，文件缺失由前端回退默认图标）
function validIcon(value) {
  if (typeof value !== 'string') return false;
  return /^img\/icons\/[a-zA-Z0-9_-]+\.(?:png|jpe?g|webp|gif|ico|svg)$/.test(value)
    || /^api\.php\?action=icon&name=[\p{L}\p{N}][\p{L}\p{N}._-]*\.(?:png|jpg|webp|gif|ico|svg)$/u.test(value)
    || /^img\/uploads\/[a-zA-Z0-9._-]+\.(?:png|jpe?g|webp|gif|ico)$/.test(value);
}
function validUploadName(value) {
  return typeof value === 'string' && /^[\p{L}\p{N}][\p{L}\p{N}._-]*\.(?:png|jpg|webp|gif|ico|svg)$/u.test(value);
}
async function readJson(env, key) { const raw = await env.NAV.get(key); if (raw === null) return null; try { return JSON.parse(raw); } catch { return null; } }
async function writeJson(env, key, value, options) { await env.NAV.put(key, JSON.stringify(value), options); }

// URL 校验与 api.php 相同：{host} 占位符先替换为保留域名，再要求 http/https。
function validUrl(value) {
  const check = value.replaceAll('{host}', 'placeholder.invalid');
  try { const parsed = new URL(check); return parsed.protocol === 'http:' || parsed.protocol === 'https:'; } catch { return false; }
}
function validateCategories(categories) {
  if (!isList(categories) || categories.length > 30) return fail('分类必须是列表，最多 30 个。');
  const result = []; const ids = new Set(); let siteCount = 0;
  for (const category of categories) {
    if (!category || typeof category !== 'object' || !validId(category.id) || ids.has(category.id)) return fail('分类标识重复或无效。');
    ids.add(category.id);
    const title = textValue(category.title, 60, '分类名称');
    if (title instanceof Response) return title;
    if (!isList(category.sites)) return fail('网站列表格式不正确。');
    const sites = [];
    for (const site of category.sites) {
      if (++siteCount > 1000) return fail('网站总数不能超过 1000 个。');
      if (!site || typeof site !== 'object' || !validId(site.id) || ids.has(site.id)) return fail('网站标识重复或无效。');
      ids.add(site.id);
      const name = textValue(site.name, 80, '网站名称');
      if (name instanceof Response) return name;
      const url = textValue(site.url, 2048, '网站网址');
      if (url instanceof Response) return url;
      if (!validUrl(url)) return fail('网址必须是完整的 http:// 或 https:// 地址，可用 {host} 代替主机名。');
      const icon = site.icon ?? 'img/icons/default.svg';
      if (!validIcon(icon)) return fail('图标路径格式不正确，请重新选择图标。');
      sites.push({ id: site.id, name, url, icon });
    }
    result.push({ id: category.id, title, sites });
  }
  return result;
}

// 首次访问：从静态资源读取 links/default.json 作为初始内容（与 PHP 版行为一致，首次保存后以 KV 为准）
async function seedCategories(env, origin) {
  try {
    const response = await env.ASSETS.fetch(new Request(new URL('/links/default.json', origin)));
    if (!response.ok) return [];
    const seed = validateCategories(await response.json());
    return seed instanceof Response ? [] : seed;
  } catch { return []; }
}
async function currentSite(env, origin) {
  const site = await readJson(env, 'site');
  if (site !== null && Array.isArray(site.categories)) return { updatedAt: site.updatedAt ?? null, categories: site.categories };
  return { updatedAt: null, categories: await seedCategories(env, origin) };
}
async function saveSite(env, origin, categories) {
  const current = await currentSite(env, origin);
  await writeJson(env, 'backup', { backedUpAt: new Date().toISOString(), site: current });
  const site = { updatedAt: new Date().toISOString(), categories };
  await writeJson(env, 'site', site);
  return site;
}

function parseCookies(request) {
  const jar = {};
  for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0) jar[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return jar;
}
function sessionCookie(id, request) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `nav_sid=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL}${secure}`;
}
async function loadSession(env, request) {
  const id = parseCookies(request).nav_sid;
  if (!id || !/^[a-f0-9]{32}$/.test(id)) return null;
  const record = await readJson(env, 'session:' + id);
  if (!record || !record.csrf || !record.last || record.last <= Math.floor(Date.now() / 1000) - SESSION_TTL) return null;
  return { id, ...record };
}
async function createSession(env, request, adminSecret) {
  const id = randHex(16);
  const record = { admin: adminSecret ? await sha256hex(adminSecret) : null, csrf: randHex(32), last: Math.floor(Date.now() / 1000) };
  await writeJson(env, 'session:' + id, record, { expirationTtl: SESSION_TTL });
  return { id, ...record, setCookie: sessionCookie(id, request) };
}
async function authenticated(env, session) {
  if (!session || !session.admin) return false;
  const admin = await readJson(env, 'admin');
  return !!admin && typeof admin.derived === 'string' && safeEqual(session.admin, await sha256hex(admin.derived));
}
async function rateLimited(env, request) {
  const key = 'attempt:' + await sha256hex(request.headers.get('CF-Connecting-IP') ?? request.headers.get('X-Forwarded-For') ?? 'unknown');
  const now = Math.floor(Date.now() / 1000);
  const entry = (await readJson(env, key)) ?? { since: now, count: 0 };
  if (entry.since < now - ATTEMPT_WINDOW) { entry.since = now; entry.count = 0; }
  return { limited: entry.count >= MAX_ATTEMPTS, key, entry };
}
async function recordFailure(env, key, entry) { entry.count++; await writeJson(env, key, entry, { expirationTtl: ATTEMPT_WINDOW }); }

function sniffImage(bytes) {
  const b = bytes;
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length > 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return 'gif';
  if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
  if (b.length > 6 && b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00) return 'ico';
  return null;
}
function sniffSvg(text) {
  if (text.length > 2 * 1024 * 1024) return false;
  return /<svg[\s>]/i.test(text) && /(?:<\/svg>|\/>)\s*$/i.test(text);
}
// 文件名净化，与 api.php 相同规则：保留中文/字母/数字/点/下划线/连字符，最多 40 字，首字符须为文字或数字
function sanitizeStem(originalName) {
  let stem = (originalName ?? '').replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^[._-]+|[._-]+$/gu, '');
  if ([...stem].length > 40) stem = [...stem].slice(0, 40).join('');
  return /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u.test(stem) ? stem : 'icon';
}

async function handleApi(request, env, url) {
  const action = url.searchParams.get('action') ?? 'site';
  const method = request.method;
  const getActions = ['site', 'session', 'icons'];
  const postActions = ['login', 'setup', 'logout', 'save', 'upload'];

  // 上传图标对访客公开，仅经此接口输出（对应 api.php 的 icon 动作）
  if (action === 'icon') {
    if (method !== 'GET') { const r = fail('请求方法不正确。', 405); r.headers.set('Allow', 'GET'); return r; }
    const name = url.searchParams.get('name') ?? '';
    if (!validUploadName(name)) return new Response(null, { status: 404 });
    const stored = await env.NAV.get('icon:' + name, { type: 'arrayBuffer', cacheTtl: 604800 });
    if (stored === null) return new Response(null, { status: 404 });
    const extension = name.split('.').pop().toLowerCase();
    const headers = { 'Content-Type': MIME[extension] ?? 'application/octet-stream', 'Cache-Control': 'public, max-age=604800', 'X-Content-Type-Options': 'nosniff' };
    if (extension === 'svg') headers['Content-Security-Policy'] = 'sandbox'; // SVG 为可执行文档，沙箱禁止直接打开时运行脚本
    return new Response(stored, { headers });
  }

  if (!getActions.includes(action) && !postActions.includes(action)) return fail('接口不存在。', 404);
  const allowedGet = getActions.includes(action) && method === 'GET';
  const allowedPost = postActions.includes(action) && method === 'POST';
  if (!allowedGet && !allowedPost) { const r = fail('请求方法不正确。', 405); r.headers.set('Allow', getActions.includes(action) ? 'GET' : 'POST'); return r; }

  if (action === 'site') return respond(await currentSite(env, url.origin));

  let session = await loadSession(env, request);
  if (action === 'session') {
    if (!session) session = await createSession(env, request, null);
    return respond({ authenticated: await authenticated(env, session), configured: (await readJson(env, 'admin')) !== null, csrf: session.csrf },
      200, session.setCookie ? { 'Set-Cookie': session.setCookie } : {});
  }

  if (method === 'POST') {
    const csrf = request.headers.get('X-CSRF-Token') ?? '';
    if (!session || !safeEqual(csrf, session.csrf)) return fail('会话校验失败，请刷新页面后重试。', 403);
    const origin = request.headers.get('Origin') ?? '';
    if (origin !== '') {
      let originHost = null;
      try { originHost = new URL(origin).host; } catch { originHost = ''; }
      if (originHost.toLowerCase() !== (url.host ?? '').toLowerCase()) return fail('请求来源不正确。', 403);
    }
  }

  if (action === 'login' || action === 'setup') {
    const raw = await request.text();
    if (raw.length > BODY_LIMIT) return fail('配置超过大小限制。', 413);
    let input;
    try { input = JSON.parse(raw); } catch { return fail('JSON 格式不正确。'); }
    if (!input || typeof input !== 'object') return fail('请求格式不正确。');
    const password = input.password;
    if (typeof password !== 'string' || password.length > 72 || password.includes('\0')) return fail('密码最多 72 字节（英文字符按 1 字节、常见汉字按 3 字节计算）。');
    const derived = typeof input.pbkdf2 === 'string' ? input.pbkdf2 : '';
    if (!/^[a-f0-9]{64}$/.test(derived)) return fail('页面版本过旧或未通过 https 访问，请强制刷新后重试。');

    const state = await rateLimited(env, request);
    if (state.limited) return fail('尝试次数过多，请在 15 分钟后重试。', 429);
    const admin = await readJson(env, 'admin');
    if (action === 'setup') {
      if (admin !== null && PASSWORD_RESET !== 'true') return fail('管理员已创建，请直接登录。', 409);
      if (codePoints(password) < 6) return fail('请设置至少 6 个字符的密码。', 400);
      await writeJson(env, 'admin', { derived, createdAt: new Date().toISOString() });
      await env.NAV.delete(state.key);
      const fresh = await createSession(env, request, derived);
      return respond({ ok: true, csrf: fresh.csrf }, 200, { 'Set-Cookie': fresh.setCookie });
    }
    if (admin === null || typeof admin.derived !== 'string' || !safeEqual(derived, admin.derived)) {
      await recordFailure(env, state.key, state.entry);
      return fail('密码不正确，或管理员尚未创建。', 401);
    }
    await env.NAV.delete(state.key);
    const fresh = await createSession(env, request, admin.derived);
    return respond({ ok: true, csrf: fresh.csrf }, 200, { 'Set-Cookie': fresh.setCookie });
  }

  if (action === 'logout') {
    if (session) await env.NAV.delete('session:' + session.id);
    return respond({ ok: true }, 200, { 'Set-Cookie': `nav_sid=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` });
  }

  // 以下动作需要已登录（对应 requireAdmin）
  if (!(await authenticated(env, session))) return fail('登录已失效，请重新登录；未保存的内容仍保留在当前页面。', 401);
  session.last = Math.floor(Date.now() / 1000);
  await writeJson(env, 'session:' + session.id, { admin: session.admin, csrf: session.csrf, last: session.last }, { expirationTtl: SESSION_TTL });

  if (action === 'icons') {
    const icons = BUILTIN_ICONS.map(name => 'img/icons/' + name);
    const listed = await env.NAV.list({ prefix: 'icon:' });
    for (const key of listed.keys) icons.push('api.php?action=icon&name=' + key.name.slice('icon:'.length));
    // 按显示的文件名自然排序（忽略路径前缀），与 api.php 及文件管理器顺序一致
    const label = value => { const index = value.indexOf('name='); return index === -1 ? value.split('/').pop() : value.slice(index + 5); };
    icons.sort((a, b) => label(a).localeCompare(label(b), 'en', { numeric: true, sensitivity: 'base' }));
    return respond({ icons });
  }

  if (action === 'save') {
    const raw = await request.text();
    if (raw.length > BODY_LIMIT) return fail('配置超过大小限制。', 413);
    let input;
    try { input = JSON.parse(raw); } catch { return fail('JSON 格式不正确。'); }
    const categories = validateCategories(input?.categories);
    if (categories instanceof Response) return categories;
    return respond(await saveSite(env, url.origin, categories));
  }

  if (action === 'upload') {
    let form;
    try { form = await request.formData(); } catch { return fail('上传失败，请重试或检查文件大小（不超过 2 MB）。'); }
    const file = form.get('icon');
    if (!(file instanceof File)) return fail('上传失败，请选择图片。');
    if (file.size > 2 * 1024 * 1024 || file.size <= 0) return fail('图片必须小于或等于 2 MB。', 413);
    const bytes = new Uint8Array(await file.arrayBuffer());
    let extension = sniffImage(bytes);
    if (extension === null) {
      // 无位图头时按 SVG 文本校验（与 api.php 分支逻辑一致）
      if (sniffSvg(await file.text())) extension = 'svg';
      else return fail('请选择有效的 PNG、JPG、WebP、GIF、ICO 或 SVG 图片（位图宽高不超过 4096 像素）。');
    }
    const stem = sanitizeStem(file.name);
    const stamp = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace(/[-:T]/g, ''); // YYYYMMDD-HHMMSS，按北京时间（与 api.php 的 Asia/Shanghai 一致）
    let name = `${stem}-${stamp}.${extension}`;
    while (await env.NAV.get('icon:' + name) !== null) name = `${stem}-${stamp}-${randHex(3)}.${extension}`;
    await env.NAV.put('icon:' + name, bytes, { metadata: { contentType: MIME[extension] } });
    return respond({ path: 'api.php?action=icon&name=' + name });
  }

  return fail('接口不存在。', 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.endsWith('/api.php')) return await handleApi(request, env, url);
      return await env.ASSETS.fetch(request);
    } catch (error) {
      console.error('Navigation Worker: ' + (error?.message ?? error));
      return respond({ error: '服务器处理失败，请检查 Worker 日志与 KV 存储。' }, 500);
    }
  }
};
