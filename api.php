<?php
declare(strict_types=1);

// PHP 8.1+，无数据库、无第三方依赖。单管理员个人主页：打开页面即可设置密码，无需安装密钥。
// 忘记密码：把下面的常量改为 true 保存，在主页「管理」重新设置密码，完成后再改回 false。
const PASSWORD_RESET = false;

// 私有数据文件带 PHP 退出前缀，即使 Nginx 不做拦截，Web 直接访问也只会得到 404。
const PRIVATE_PREFIX = "<?php http_response_code(404); exit; __halt_compiler();\n";
const STORAGE = __DIR__ . '/storage';
const SITE_FILE = STORAGE . '/site.php';
const AUTH_FILE = STORAGE . '/admin.php';
const BACKUP_FILE = STORAGE . '/backup.php';
const ICON_DIR = STORAGE . '/icons';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, private, max-age=0');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: same-origin');
ini_set('display_errors', '0');
umask(0027);
// 上传图标文件名中的日期按此时区生成，保证与你看到的时间一致。
date_default_timezone_set('Asia/Shanghai');

function respond(array $data, int $status = 200): void {
    http_response_code($status);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
    exit;
}
function fail(string $message, int $status = 400): void { respond(['error' => $message], $status); }
function ensureDirectory(string $path, int $mode = 0750): void {
    if (!is_dir($path) && !@mkdir($path, $mode, true) && !is_dir($path)) {
        throw new RuntimeException('无法创建数据目录，请检查 PHP 用户对 storage 的写入权限。');
    }
}
function readPrivate(string $path): ?array {
    if (!is_file($path)) return null;
    $raw = file_get_contents($path);
    if ($raw === false || strncmp($raw, PRIVATE_PREFIX, strlen(PRIVATE_PREFIX)) !== 0) {
        throw new RuntimeException('数据文件格式异常，请用 storage/backup.php 恢复，不要直接覆盖原文件。');
    }
    $data = json_decode(substr($raw, strlen(PRIVATE_PREFIX)), true, 512, JSON_THROW_ON_ERROR);
    if (!is_array($data)) throw new RuntimeException('数据文件格式异常。');
    return $data;
}
function writePrivate(string $path, array $data): void {
    ensureDirectory(dirname($path));
    // 临时文件也使用 .php 后缀，避免被 Web 当作明文下载。
    $temporary = dirname($path) . '/tmp-' . bin2hex(random_bytes(12)) . '.php';
    $body = PRIVATE_PREFIX . json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR);
    try {
        if (file_put_contents($temporary, $body, LOCK_EX) !== strlen($body)) throw new RuntimeException('写入失败，请检查磁盘空间与目录权限。');
        @chmod($temporary, 0640);
        if (!rename($temporary, $path)) throw new RuntimeException('保存失败，请检查目录权限。');
    } finally {
        if (is_file($temporary)) @unlink($temporary);
    }
}
function locked(callable $callback) {
    ensureDirectory(STORAGE);
    $handle = fopen(STORAGE . '/write.lock', 'c');
    if ($handle === false) throw new RuntimeException('无法锁定配置文件，请检查 storage 权限。');
    try {
        if (!flock($handle, LOCK_EX)) throw new RuntimeException('无法锁定配置文件。');
        return $callback();
    } finally { flock($handle, LOCK_UN); fclose($handle); }
}
function authenticated(): bool {
    $admin = readPrivate(AUTH_FILE);
    return $admin !== null && isset($_SESSION['admin'], $_SESSION['last_active'])
        && $_SESSION['last_active'] > time() - 7200
        && hash_equals(hash('sha256', $admin['hash']), (string)$_SESSION['admin']);
}
function requireAdmin(): void {
    if (!authenticated()) fail('登录已失效，请重新登录；未保存的内容仍保留在当前页面。', 401);
    $_SESSION['last_active'] = time();
}
function signIn(string $hash): string {
    session_regenerate_id(true);
    $_SESSION['admin'] = hash('sha256', $hash);
    $_SESSION['last_active'] = time();
    $_SESSION['csrf'] = bin2hex(random_bytes(32));
    return $_SESSION['csrf'];
}
function body(): array {
    if (stripos($_SERVER['CONTENT_TYPE'] ?? '', 'application/json') !== 0) fail('请求格式不正确。', 415);
    $raw = file_get_contents('php://input', false, null, 0, 1048577);
    if ($raw === false || strlen($raw) > 1048576) fail('配置超过大小限制。', 413);
    try { $data = json_decode($raw, true, 64, JSON_THROW_ON_ERROR); }
    catch (JsonException $error) { fail('JSON 格式不正确。'); }
    if (!is_array($data)) fail('请求格式不正确。');
    return $data;
}
function validId($value): bool {
    return is_string($value) && preg_match('/^[a-zA-Z0-9_-]{1,80}$/D', $value) === 1;
}
function textValue($value, int $maximum, string $field): string {
    if (!is_string($value)) fail($field . '格式不正确。');
    $value = trim($value);
    $length = preg_match_all('/./us', $value);
    if ($length === false || $length === 0 || $length > $maximum || preg_match('/[\x00-\x1F\x7F]/', $value)) fail($field . '为空、过长或含无效字符。');
    return $value;
}
// 上传图标文件名：中文、字母、数字、点、下划线、连字符，首字符必须是文字或数字（禁止 ../ 等路径写法）。
function validUploadName($value): bool {
    return is_string($value) && preg_match('/^[\p{L}\p{N}][\p{L}\p{N}._-]*\.(?:png|jpg|webp|gif|ico|svg)$/uD', $value) === 1;
}
// 图标只需格式正确；文件不存在时前端会自动显示默认图标，不会阻塞保存。
function validIcon($value): bool {
    if (!is_string($value)) return false;
    if (preg_match('~^img/icons/[a-zA-Z0-9_-]+\.(?:png|jpe?g|webp|gif|ico|svg)$~D', $value) === 1) return true;
    if (preg_match('~^api\.php\?action=icon&name=[\p{L}\p{N}][\p{L}\p{N}._-]*\.(?:png|jpg|webp|gif|ico|svg)$~uD', $value) === 1) return true;
    // 兼容旧版本存在 img/uploads/ 的图标路径。
    return preg_match('~^img/uploads/[a-zA-Z0-9._-]+\.(?:png|jpe?g|webp|gif|ico)$~D', $value) === 1;
}
function validateCategories($categories): array {
    if (!is_array($categories) || !array_is_list($categories) || count($categories) > 30) fail('分类必须是列表，最多 30 个。');
    $result = []; $ids = []; $siteCount = 0;
    foreach ($categories as $category) {
        if (!is_array($category) || !validId($category['id'] ?? null) || isset($ids[$category['id']])) fail('分类标识重复或无效。');
        $ids[$category['id']] = true;
        $title = textValue($category['title'] ?? null, 60, '分类名称');
        if (!isset($category['sites']) || !is_array($category['sites']) || !array_is_list($category['sites'])) fail('网站列表格式不正确。');
        $sites = [];
        foreach ($category['sites'] as $site) {
            if (++$siteCount > 1000) fail('网站总数不能超过 1000 个。');
            if (!is_array($site) || !validId($site['id'] ?? null) || isset($ids[$site['id']])) fail('网站标识重复或无效。');
            $ids[$site['id']] = true;
            $name = textValue($site['name'] ?? null, 80, '网站名称');
            $url = textValue($site['url'] ?? null, 2048, '网站网址');
            // {host} 占位符由浏览器替换为当前访问主页的主机名，校验时用保留域名代替后检查。
            $check = str_replace('{host}', 'placeholder.invalid', $url);
            if (!filter_var($check, FILTER_VALIDATE_URL) || !in_array(strtolower(parse_url($check, PHP_URL_SCHEME) ?? ''), ['http', 'https'], true)) fail('网址必须是完整的 http:// 或 https:// 地址，可用 {host} 代替主机名。');
            $icon = $site['icon'] ?? 'img/icons/default.svg';
            if (!validIcon($icon)) fail('图标路径格式不正确，请重新选择图标。');
            $sites[] = ['id' => $site['id'], 'name' => $name, 'url' => $url, 'icon' => $icon];
        }
        $result[] = ['id' => $category['id'], 'title' => $title, 'sites' => $sites];
    }
    return $result;
}
function currentSite(): array {
    $site = readPrivate(SITE_FILE);
    if ($site !== null) return $site;
    // 首次访问：把 links/default.json（与 storage/site.php 中 categories 同格式）作为初始内容导入。
    // 想更换初始内容或空白开局，直接编辑该文件即可；第一次保存后不再读取。
    $raw = @file_get_contents(__DIR__ . '/links/default.json');
    if ($raw === false) return ['updatedAt' => null, 'categories' => []];
    $seed = json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
    $categories = validateCategories(is_array($seed) && array_is_list($seed) ? $seed : null);
    return ['updatedAt' => null, 'categories' => $categories];
}
function saveSite(array $categories): array {
    $current = currentSite();
    // 保存前自动备份当前版本到 storage/backup.php，误改可手动恢复。
    writePrivate(BACKUP_FILE, ['backedUpAt' => gmdate('c'), 'site' => $current]);
    $site = ['updatedAt' => gmdate('c'), 'categories' => $categories];
    writePrivate(SITE_FILE, $site);
    return $site;
}
function authAttempt(callable $callback): array {
    return locked(function () use ($callback) {
        $now = time();
        $attempts = readPrivate(STORAGE . '/attempts.php') ?? [];
        foreach ($attempts as $key => $entry) if (($entry['since'] ?? 0) < $now - 900) unset($attempts[$key]);
        $key = hash('sha256', $_SERVER['REMOTE_ADDR'] ?? 'unknown');
        $entry = $attempts[$key] ?? ['since' => $now, 'count' => 0];
        if ($entry['count'] >= 8) fail('尝试次数过多，请在 15 分钟后重试。', 429);
        $result = $callback();
        if (isset($result['error'])) { $entry['count']++; $attempts[$key] = $entry; }
        else unset($attempts[$key]);
        writePrivate(STORAGE . '/attempts.php', $attempts);
        return $result;
    });
}
function serveIcon($name): void {
    $file = validUploadName($name) ? ICON_DIR . '/' . $name : '';
    if ($file === '' || !is_file($file)) { http_response_code(404); exit; }
    $types = ['png' => 'image/png', 'jpg' => 'image/jpeg', 'webp' => 'image/webp', 'gif' => 'image/gif', 'ico' => 'image/x-icon', 'svg' => 'image/svg+xml'];
    $extension = strtolower(pathinfo($file, PATHINFO_EXTENSION));
    header('Content-Type: ' . ($types[$extension] ?? 'application/octet-stream'));
    // SVG 是可执行文档：沙箱响应头保证直接打开图标地址时脚本不会运行（<img> 加载场景本就不执行脚本）。
    if ($extension === 'svg') header('Content-Security-Policy: sandbox');
    header('Cache-Control: public, max-age=604800');
    header('Content-Length: ' . (string)filesize($file));
    readfile($file);
    exit;
}

try {
    $action = $_GET['action'] ?? 'site';
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    if (!is_string($action)) fail('请求格式不正确。');

    // 上传图标对访客公开（主页要显示），仅通过此接口输出，storage 目录本身不需要开放。
    if ($action === 'icon') {
        if ($method !== 'GET') { header('Allow: GET'); fail('请求方法不正确。', 405); }
        serveIcon($_GET['name'] ?? null);
    }

    $getActions = ['site', 'session', 'icons'];
    $postActions = ['login', 'setup', 'logout', 'save', 'upload'];
    if (!in_array($action, array_merge($getActions, $postActions), true)) fail('接口不存在。', 404);
    if (($method !== 'GET' || !in_array($action, $getActions, true)) && ($method !== 'POST' || !in_array($action, $postActions, true))) {
        header('Allow: ' . (in_array($action, $getActions, true) ? 'GET' : 'POST'));
        fail('请求方法不正确。', 405);
    }
    if ($action === 'site') respond(currentSite());

    ini_set('session.use_strict_mode', '1');
    ini_set('session.use_only_cookies', '1');
    session_name('nav_admin');
    $cookiePath = rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '/api.php')), '/');
    session_set_cookie_params(['lifetime' => 0, 'path' => ($cookiePath ?: '') . '/', 'secure' => !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off', 'httponly' => true, 'samesite' => 'Strict']);
    if (!session_start()) throw new RuntimeException('无法启动登录会话，请检查 PHP session 目录权限。');
    if (!isset($_SESSION['csrf'])) $_SESSION['csrf'] = bin2hex(random_bytes(32));

    if ($action === 'session') respond(['authenticated' => authenticated(), 'configured' => is_file(AUTH_FILE), 'csrf' => $_SESSION['csrf']]);
    if ($method === 'POST') {
        $csrf = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '';
        if (!is_string($csrf) || !hash_equals($_SESSION['csrf'], $csrf)) fail('会话校验失败，请刷新页面后重试。', 403);
        $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
        if ($origin !== '') {
            $originHost = parse_url($origin, PHP_URL_HOST);
            $originPort = parse_url($origin, PHP_URL_PORT);
            $authority = strtolower((string)$originHost . ($originPort !== null ? ':' . $originPort : ''));
            if ($authority !== strtolower($_SERVER['HTTP_HOST'] ?? '')) fail('请求来源不正确。', 403);
        }
    }
    if ($action === 'login' || $action === 'setup') {
        $input = body();
        $password = $input['password'] ?? '';
        if (!is_string($password) || strlen($password) > 72 || str_contains($password, "\0")) fail('密码最多 72 字节（英文字符按 1 字节、常见汉字按 3 字节计算）。');
        $result = authAttempt(function () use ($action, $password) {
            if ($action === 'setup') {
                if (is_file(AUTH_FILE) && !PASSWORD_RESET) return ['error' => '管理员已创建，请直接登录。', 'status' => 409];
                $length = preg_match_all('/./us', $password);
                if ($length === false || $length < 6) return ['error' => '请设置至少 6 个字符的密码。', 'status' => 400];
                $hash = password_hash($password, PASSWORD_DEFAULT);
                writePrivate(AUTH_FILE, ['hash' => $hash, 'createdAt' => gmdate('c')]);
            } else {
                $admin = readPrivate(AUTH_FILE);
                if ($admin === null || !password_verify($password, $admin['hash'])) return ['error' => '密码不正确，或管理员尚未创建。', 'status' => 401];
                $hash = $admin['hash'];
            }
            return ['hash' => $hash];
        });
        if (isset($result['error'])) fail($result['error'], $result['status']);
        respond(['ok' => true, 'csrf' => signIn($result['hash'])]);
    }
    if ($action === 'logout') {
        $_SESSION = [];
        session_regenerate_id(true);
        $_SESSION['csrf'] = bin2hex(random_bytes(32));
        respond(['ok' => true]);
    }
    requireAdmin();
    if ($action === 'icons') {
        $icons = [];
        foreach (glob(__DIR__ . '/img/icons/*') ?: [] as $file) {
            $path = 'img/icons/' . basename($file);
            if (validIcon($path)) $icons[] = $path;
        }
        foreach (glob(ICON_DIR . '/*') ?: [] as $file) {
            $path = 'api.php?action=icon&name=' . basename($file);
            if (validIcon($path)) $icons[] = $path;
        }
        // 按显示的文件名自然排序（忽略路径前缀），与文件管理器顺序一致：
        // 上传图标取 name= 后的文件名，内置图标取 basename；否则 api.php 前缀会让上传图标整块错位到最前。
        $label = static function (string $path): string {
            $offset = strpos($path, 'name=');
            return $offset === false ? basename($path) : substr($path, $offset + 5);
        };
        usort($icons, static fn(string $a, string $b): int => strnatcasecmp($label($a), $label($b)));
        respond(['icons' => $icons]);
    }
    if ($action === 'save') {
        $input = body();
        $categories = validateCategories($input['categories'] ?? null);
        respond(locked(fn() => saveSite($categories)));
    }
    if ($action === 'upload') {
        $file = $_FILES['icon'] ?? null;
        if (!is_array($file) || !is_int($file['error'] ?? null) || $file['error'] !== UPLOAD_ERR_OK) fail('上传失败，请选择图片并检查 PHP 的 upload_max_filesize 和 post_max_size（建议至少 4M）。');
        if ($file['size'] > 2 * 1024 * 1024 || $file['size'] <= 0) fail('图片必须小于或等于 2 MB。', 413);
        if (!is_uploaded_file($file['tmp_name'])) fail('上传文件无效。');
        // 按内容判定格式：SVG 是文本，getimagesize 不认识它；其余位图仍走像素校验。
        $head = (string) @file_get_contents($file['tmp_name'], false, null, 0, 8192);
        if (stripos($head, '<svg') !== false) {
            $svg = (string) @file_get_contents($file['tmp_name']);
            if (preg_match('/<svg[\s>]/i', $svg) !== 1 || preg_match('/(?:<\/svg>|\/>)\s*$/i', $svg) !== 1) fail('这不是有效的 SVG 文件（需包含完整的 <svg> 根元素）。');
            $extension = 'svg';
        } else {
            $info = @getimagesize($file['tmp_name']);
            $types = [IMAGETYPE_PNG => 'png', IMAGETYPE_JPEG => 'jpg', IMAGETYPE_GIF => 'gif', IMAGETYPE_WEBP => 'webp', IMAGETYPE_ICO => 'ico'];
            if ($info === false || !isset($types[$info[2]]) || $info[0] > 4096 || $info[1] > 4096 || $info[0] < 1 || $info[1] < 1) fail('请选择有效的 PNG、JPG、WebP、GIF、ICO 或 SVG 图片（位图宽高不超过 4096 像素）。');
            $extension = $types[$info[2]];
        }
        ensureDirectory(ICON_DIR, 0750);
        // 文件名 = 原文件名（净化后，保留中文/字母/数字/点/下划线/连字符，最多 40 字）- 上传时间，便于识别且不易重复。
        $stem = trim((string) preg_replace('/[^\p{L}\p{N}._-]+/u', '-', (string) pathinfo((string) ($file['name'] ?? ''), PATHINFO_FILENAME)), '._-');
        if (preg_match('/^.{0,40}/us', $stem, $matched) === 1) $stem = $matched[0];
        if (preg_match('/^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u', $stem) !== 1) $stem = 'icon';
        $name = $stem . '-' . date('Ymd-His') . '.' . $extension;
        // 同一秒内上传同名文件时，追加随机后缀避免覆盖。
        if (is_file(ICON_DIR . '/' . $name)) $name = $stem . '-' . date('Ymd-His') . '-' . bin2hex(random_bytes(3)) . '.' . $extension;
        if (!move_uploaded_file($file['tmp_name'], ICON_DIR . '/' . $name)) throw new RuntimeException('图标保存失败，请检查 storage/icons 的写入权限。');
        @chmod(ICON_DIR . '/' . $name, 0640);
        respond(['path' => 'api.php?action=icon&name=' . $name]);
    }
} catch (Throwable $error) {
    error_log('Navigation API: ' . $error->getMessage());
    respond(['error' => '服务器处理失败，请检查 PHP 错误日志、storage 的写入权限及磁盘空间。'], 500);
}
