'use strict';

const $ = id => document.getElementById(id);
const state = { categories: [], saved: [], csrf: '', editing: false, dirty: false, busy: false, icons: [] };
let editingSite = null;
let editingCategory = null;
let deletingCategory = null;
let dragged = null;
let setupMode = false;
const clone = value => JSON.parse(JSON.stringify(value));
const newId = () => 'id-' + (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const iconLabel = path => path.includes('name=') ? path.split('name=')[1] : path.split('/').pop();
// {host} 占位符解析为当前访问主页的主机名（IPv6 补方括号），NAS 换 IP 后链接自动跟随。
const pageHost = location.hostname ? (location.hostname.includes(':') ? '[' + location.hostname + ']' : location.hostname) : 'localhost';
const resolveUrl = url => url.replaceAll('{host}', pageHost);
// 客户端 PBKDF2-SHA256（60 万次）：Workers 版后端只存/比对派生值（免费版 CPU 跑不动服务端 KDF）；
// NAS 版同时收到明文 password 字段，bcrypt 流程不变。非安全上下文（http:// 局域网）无 SubtleCrypto 时返回 null，
// 此时只发明文字段——NAS 版正常登录，Workers 版请始终通过 https 访问。
async function deriveKey(password) {
  if (!crypto.subtle) return null;
  try {
    const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: new TextEncoder().encode('home-nas-nav-v1'), iterations: 600000, hash: 'SHA-256' }, material, 256);
    return [...new Uint8Array(bits)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  } catch { return null; }
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function api(action, options = {}) {
  const headers = { ...options.headers };
  if (options.method === 'POST') headers['X-CSRF-Token'] = state.csrf;
  if (options.body && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }
  const response = await fetch('api.php?action=' + encodeURIComponent(action), {
    ...options, headers, credentials: 'same-origin', cache: 'no-store'
  });
  let data;
  try { data = await response.json(); }
  catch { throw new Error('服务器未返回有效数据，请检查 PHP 是否启用及站点部署配置。'); }
  if (!response.ok) {
    if (response.status === 401) promptRelogin();
    const error = new Error(data.error || '操作失败，请重试。');
    error.status = response.status;
    throw error;
  }
  return data;
}

function message(text, error = false) {
  $('pageMessage').textContent = text;
  $('pageMessage').hidden = !text;
  $('pageMessage').classList.toggle('error', error);
}

function updateToolbar() {
  $('saveButton').disabled = state.busy || !state.dirty;
  $('saveButton').textContent = state.busy ? '保存中…' : '保存更改';
  $('saveState').textContent = state.dirty ? '有尚未保存的更改' : '所有更改已保存';
  $('saveState').classList.toggle('unsaved', state.dirty);
}

function changed() {
  state.dirty = true;
  message('');
  render();
}

function actionButton(text, title, handler, className = '') {
  const button = element('button', 'small-button ' + className, text);
  button.type = 'button';
  button.title = title;
  button.setAttribute('aria-label', title);
  button.addEventListener('click', handler);
  return button;
}

function dragHandle(type, categoryId, siteId = null) {
  const handle = element('button', 'drag-handle small-button', '⠿');
  handle.type = 'button';
  handle.draggable = true;
  handle.title = type === 'category' ? '拖动分类排序' : '拖动网站排序或移到其他分类';
  handle.setAttribute('aria-label', handle.title);
  handle.addEventListener('dragstart', event => {
    dragged = { type, categoryId, siteId };
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', siteId || categoryId);
    const target = handle.closest(type === 'site' ? 'li' : 'section');
    if (target) event.dataTransfer.setDragImage(target, 12, 12);
    event.stopPropagation();
  });
  handle.addEventListener('dragend', () => {
    dragged = null;
    document.querySelectorAll('.drop-target').forEach(node => node.classList.remove('drop-target'));
  });
  return handle;
}

function moveItem(items, index, delta) {
  const next = index + delta;
  if (next < 0 || next >= items.length) return;
  [items[index], items[next]] = [items[next], items[index]];
  changed();
}

function dropSite(targetCategory, beforeSiteId = null) {
  if (!dragged || dragged.type !== 'site') return;
  const source = state.categories.find(category => category.id === dragged.categoryId);
  const index = source?.sites.findIndex(site => site.id === dragged.siteId) ?? -1;
  if (index < 0 || beforeSiteId === dragged.siteId) return;
  const [site] = source.sites.splice(index, 1);
  const targetIndex = beforeSiteId ? targetCategory.sites.findIndex(item => item.id === beforeSiteId) : -1;
  targetCategory.sites.splice(targetIndex < 0 ? targetCategory.sites.length : targetIndex, 0, site);
  dragged = null;
  changed();
}

function render() {
  const container = $('links-container');
  container.replaceChildren();
  document.body.classList.toggle('editing', state.editing);
  $('editorBar').hidden = !state.editing;
  $('editHint').hidden = !state.editing;
  $('manageButton').textContent = '管理';
  $('manageButton').hidden = state.editing; // 编辑中无需该按钮：退出走「退出编辑」，登录失效会自动弹登录窗
  for (const [categoryIndex, category] of state.categories.entries()) {
    const section = element('section', 'category-card');
    section.dataset.categoryId = category.id;
    const heading = element('div', 'category-heading');
    heading.append(element('h2', '', category.title));
    if (state.editing) {
      const controls = element('div', 'category-tools');
      controls.append(
        dragHandle('category', category.id),
        actionButton('↑', '上移分类：' + category.title, () => moveItem(state.categories, categoryIndex, -1)),
        actionButton('↓', '下移分类：' + category.title, () => moveItem(state.categories, categoryIndex, 1)),
        actionButton('改名', '修改分类：' + category.title, () => openCategory(category)),
        actionButton('删除', '删除分类：' + category.title, () => openDeleteCategory(category), 'danger-text')
      );
      controls.children[1].disabled = categoryIndex === 0;
      controls.children[2].disabled = categoryIndex === state.categories.length - 1;
      heading.append(controls);
      section.addEventListener('dragover', event => {
        if (!dragged) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        section.classList.add('drop-target');
      });
      section.addEventListener('dragleave', event => {
        if (!section.contains(event.relatedTarget)) section.classList.remove('drop-target');
      });
      section.addEventListener('drop', event => {
        event.preventDefault();
        section.classList.remove('drop-target');
        if (dragged?.type === 'site') return dropSite(category);
        if (dragged?.type === 'category' && dragged.categoryId !== category.id) {
          const sourceIndex = state.categories.findIndex(item => item.id === dragged.categoryId);
          const [source] = state.categories.splice(sourceIndex, 1);
          state.categories.splice(categoryIndex, 0, source);
          dragged = null;
          changed();
        }
      });
    }
    section.append(heading);
    const list = element('ul', 'site-list');
    for (const [siteIndex, site] of category.sites.entries()) {
      const li = element('li', 'site-item');
      li.dataset.siteId = site.id;
      const link = element('a', 'site-link');
      link.href = resolveUrl(site.url);
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      const img = element('img');
      img.src = site.icon || 'img/icons/default.svg';
      img.alt = '';
      img.loading = 'lazy';
      img.addEventListener('error', () => { img.src = 'img/icons/default.svg'; }, { once: true });
      link.append(img, element('span', '', site.name));
      if (state.editing) {
        link.addEventListener('click', event => { event.preventDefault(); openSite(category.id, site); });
        link.title = '编辑：' + site.name;
        li.append(dragHandle('site', category.id, site.id));
      }
      li.append(link);
      if (state.editing) {
        const controls = element('div', 'site-tools');
        controls.append(
          actionButton('编辑', '编辑网站：' + site.name, () => openSite(category.id, site)),
          actionButton('↑', '上移网站：' + site.name, () => moveItem(category.sites, siteIndex, -1)),
          actionButton('↓', '下移网站：' + site.name, () => moveItem(category.sites, siteIndex, 1)),
          actionButton('×', '删除网站：' + site.name, () => {
            if (!confirm('删除「' + site.name + '」？保存主页后生效。')) return;
            category.sites.splice(siteIndex, 1);
            changed();
          }, 'danger-text')
        );
        controls.children[1].disabled = siteIndex === 0;
        controls.children[2].disabled = siteIndex === category.sites.length - 1;
        li.append(controls);
        li.addEventListener('dragover', event => {
          if (dragged?.type !== 'site') return;
          event.preventDefault();
          event.stopPropagation();
          li.classList.add('drop-target');
        });
        li.addEventListener('dragleave', () => li.classList.remove('drop-target'));
        li.addEventListener('drop', event => {
          if (dragged?.type !== 'site') return;
          event.preventDefault();
          event.stopPropagation();
          dropSite(category, site.id);
        });
      }
      list.append(li);
    }
    section.append(list);
    if (state.editing) {
      const add = element('button', 'add-site', '＋ 添加网站');
      add.type = 'button';
      add.addEventListener('click', () => openSite(category.id));
      section.append(add);
    } else if (!category.sites.length) {
      section.append(element('p', 'muted empty-note', '暂无网站'));
    }
    container.append(section);
  }
  if (!state.categories.length) container.append(element('p', 'loading', state.editing ? '点击「添加分类」开始整理你的导航站。' : '暂无导航网站'));
  updateToolbar();
}

async function enterEditing() {
  const [session, icons] = await Promise.all([api('session'), api('icons')]);
  if (!session.authenticated) throw new Error('登录已失效，请重新登录。');
  state.csrf = session.csrf;
  state.icons = icons.icons;
  state.editing = true;
  message('');
  render();
}

let reloginPending = false;

// 弹出登录/设置密码窗。session 可选：带 session 时按服务器状态决定是否显示首次创建流程，
// 不带（登录失效自动弹出）时固定按登录模式打开。
function showLoginDialog(session) {
  if (session) state.csrf = session.csrf;
  setupMode = !!session && !session.configured;
  $('confirmPasswordField').hidden = !setupMode;
  $('confirmPassword').required = setupMode;
  $('loginTitle').textContent = setupMode ? '设置管理员密码' : '管理员登录';
  $('passwordLabel').textContent = setupMode ? '设置密码（至少 6 个字符）' : '管理员密码';
  $('password').autocomplete = setupMode ? 'new-password' : 'current-password';
  $('password').minLength = setupMode ? 6 : 1;
  $('loginSubmit').textContent = setupMode ? '创建管理员并编辑' : '登录并编辑';
  $('loginHelp').textContent = setupMode
    ? '首次使用：设置仅你自己知道的管理员密码，之后用它登录编辑主页。'
    : '登录后，可以直接在主页管理网站和分类。';
  $('loginForm').reset();
  $('loginError').textContent = '';
  $('loginDialog').showModal();
}

// 会话过期（任意接口返回 401）时自动弹出登录窗：草稿仍在页面上，重新登录后继续。
// 已有对话框打开时交给该对话框内联显示错误，避免窗口叠加。
function promptRelogin() {
  if (!state.editing || $('loginDialog').open || document.querySelector('dialog[open]')) return;
  reloginPending = true;
  showLoginDialog();
  $('loginHelp').textContent = '登录已失效，请重新登录；未保存的修改仍保留在当前页面。';
  api('session').then(session => { state.csrf = session.csrf; }).catch(() => {});
}

$('manageButton').addEventListener('click', async () => {
  $('manageButton').disabled = true;
  try {
    const session = await api('session');
    state.csrf = session.csrf;
    if (session.authenticated) return await enterEditing();
    showLoginDialog(session);
  } catch (error) { message(error.message, true); }
  finally { $('manageButton').disabled = false; }
});

$('loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  $('loginError').textContent = '';
  if (setupMode && $('password').value !== $('confirmPassword').value) {
    $('loginError').textContent = '两次输入的密码不一致。';
    return;
  }
  $('loginSubmit').disabled = true;
  try {
    const password = $('password').value;
    const pbkdf2 = await deriveKey(password);
    const response = await api(setupMode ? 'setup' : 'login', {
      method: 'POST', body: pbkdf2 ? { password, pbkdf2 } : { password }
    });
    state.csrf = response.csrf;
    $('loginForm').reset();
    $('loginDialog').close();
    await enterEditing();
    if (reloginPending) {
      reloginPending = false;
      message('已重新登录，未保存的修改仍在页面上，请再次点击「保存更改」。');
    }
  } catch (error) { $('loginError').textContent = error.message; }
  finally { $('loginSubmit').disabled = false; }
});

function openSite(categoryId, site = null) {
  editingSite = site ? { categoryId, id: site.id } : null;
  $('siteTitle').textContent = site ? '编辑网站' : '添加网站';
  $('siteForm').reset();
  $('siteError').textContent = '';
  $('siteName').value = site?.name || '';
  $('siteUrl').value = site?.url || '';
  $('siteCategory').replaceChildren(...state.categories.map(category => new Option(category.title, category.id)));
  $('siteCategory').value = categoryId;
  const icons = new Set(['img/icons/default.svg', ...state.icons, ...(site?.icon ? [site.icon] : [])]);
  $('siteIcon').replaceChildren(...[...icons].map(path => new Option(iconLabel(path), path)));
  $('siteIcon').value = site?.icon || 'img/icons/default.svg';
  $('iconPreview').src = $('siteIcon').value;
  $('siteDialog').showModal();
}

$('siteIcon').addEventListener('change', () => { $('iconPreview').src = $('siteIcon').value; });
$('iconUpload').addEventListener('change', async () => {
  const file = $('iconUpload').files[0];
  if (!file) return;
  $('siteError').textContent = '';
  if (file.size > 2 * 1024 * 1024) { $('siteError').textContent = '图片不能超过 2 MB。'; return; }
  $('siteSubmit').disabled = true;
  $('iconUpload').disabled = true;
  const form = new FormData();
  form.append('icon', file);
  try {
    const data = await api('upload', { method: 'POST', body: form });
    state.icons.push(data.path);
    $('siteIcon').add(new Option(file.name, data.path));
    $('siteIcon').value = data.path;
    $('iconPreview').src = data.path;
  } catch (error) { $('siteError').textContent = error.message; }
  finally { $('siteSubmit').disabled = false; $('iconUpload').disabled = false; $('iconUpload').value = ''; }
});

$('siteForm').addEventListener('submit', event => {
  event.preventDefault();
  const name = $('siteName').value.trim();
  const url = $('siteUrl').value.trim();
  if (!name) { $('siteError').textContent = '请输入网站名称。'; return; }
  try { if (!['http:', 'https:'].includes(new URL(resolveUrl(url)).protocol)) throw new Error(); }
  catch { $('siteError').textContent = '请输入以 http:// 或 https:// 开头的完整网址。'; return; }
  const target = state.categories.find(category => category.id === $('siteCategory').value);
  const site = { id: editingSite?.id || newId(), name, url, icon: $('siteIcon').value };
  if (editingSite) {
    const source = state.categories.find(category => category.id === editingSite.categoryId);
    const index = source.sites.findIndex(item => item.id === editingSite.id);
    if (source === target) source.sites[index] = site;
    else { source.sites.splice(index, 1); target.sites.push(site); }
  } else target.sites.push(site);
  $('siteDialog').close();
  changed();
});

function openCategory(category = null) {
  editingCategory = category?.id || null;
  $('categoryTitle').textContent = category ? '修改分类' : '添加分类';
  $('categoryName').value = category?.title || '';
  $('categoryError').textContent = '';
  $('categoryDialog').showModal();
}
$('addCategoryButton').addEventListener('click', () => openCategory());
$('categoryForm').addEventListener('submit', event => {
  event.preventDefault();
  const title = $('categoryName').value.trim();
  if (!title) { $('categoryError').textContent = '请输入分类名称。'; return; }
  if (editingCategory) state.categories.find(category => category.id === editingCategory).title = title;
  else state.categories.push({ id: newId(), title, sites: [] });
  $('categoryDialog').close();
  changed();
});

function openDeleteCategory(category) {
  deletingCategory = category.id;
  $('deleteCategoryDescription').textContent = '删除「' + category.title + '」？该分类内有 ' + category.sites.length + ' 个网站。';
  const others = state.categories.filter(item => item.id !== category.id);
  $('moveSitesTarget').replaceChildren(...others.map(item => new Option('移动到：' + item.title, item.id)), new Option('同时删除分类内的所有网站', '__delete__'));
  $('moveSitesField').hidden = !category.sites.length;
  $('deleteCategoryDialog').showModal();
}
$('deleteCategoryForm').addEventListener('submit', event => {
  event.preventDefault();
  const source = state.categories.find(category => category.id === deletingCategory);
  const target = state.categories.find(category => category.id === $('moveSitesTarget').value);
  if (target) target.sites.push(...source.sites);
  state.categories = state.categories.filter(category => category.id !== deletingCategory);
  $('deleteCategoryDialog').close();
  changed();
});

function acceptSite(data) {
  state.categories = data.categories;
  state.saved = clone(data.categories);
  state.dirty = false;
  render();
}

$('saveButton').addEventListener('click', async () => {
  if (state.busy || !state.dirty) return;
  state.busy = true;
  updateToolbar();
  $('links-container').inert = true;
  $('editorBar').inert = true;
  try {
    const data = await api('save', { method: 'POST', body: { categories: state.categories } });
    acceptSite(data);
    message('已保存，刷新后其他设备即可看到最新主页。');
  } catch (error) { message(error.message, true); }
  finally { state.busy = false; $('links-container').inert = false; $('editorBar').inert = false; updateToolbar(); }
});

$('cancelButton').addEventListener('click', async () => {
  if (state.dirty && !confirm('有尚未保存的更改，确定放弃并退出编辑吗？')) return;
  try {
    const session = await api('session');
    state.csrf = session.csrf;
    await api('logout', { method: 'POST', body: {} });
    state.categories = clone(state.saved);
    state.dirty = false;
    state.editing = false;
    render();
    message('');
  } catch (error) { message(error.message, true); }
});

document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
$('searchInput').addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.isComposing || !event.target.value.trim()) return;
  event.preventDefault();
  const query = encodeURIComponent(event.target.value.trim());
  window.open(event.altKey ? 'https://www.google.com/search?q=' + query : 'https://www.baidu.com/s?wd=' + query, '_blank', 'noopener,noreferrer');
  event.target.value = '';
});
window.addEventListener('beforeunload', event => {
  if (state.dirty) { event.preventDefault(); event.returnValue = ''; }
});
window.addEventListener('pageshow', event => {
  if (event.persisted && !state.editing) loadSite();
});
async function loadSite() {
  try { acceptSite(await api('site')); message(''); }
  catch (error) { $('links-container').textContent = ''; message(error.message, true); }
}
loadSite();
