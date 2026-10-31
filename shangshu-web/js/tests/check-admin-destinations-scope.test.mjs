// 判据：管理后台那排页签**只出现在管理后台里**（用户 2026-10-24 22:2x 站上批注：
// 「然后我不知道我**为什么**这个一直出现在这里？？？」—— 指着业务受管表页上那排
// 「管理后台 / 账号管理 / AI 工具 / 导航设置 / 跨应用数据 / 系统设置」）。
//
// **病根**（查实了，不是猜的）：
//   ① `#/objects` 这一个路由**兼着两件事** —— 管理后台的「跨应用数据」目录（管理员用），
//      ＋ 业务应用的**受管表页**（任何员工从应用卡片点进来就是这一支，URL 带 `?application=`）；
//   ② 那排页签是**管理后台的页面切换条**，但 `real-objects.js` 把
//      `<nav class="admin-destinations">` **写死在页面模板里**、**无条件**画；
//   ③ `window.shangshuAdminDestinations` 是**固定六项**，**一个字都不看当前身份**
//      ⇒ 连**普通员工**都能看见「管理后台／账号管理／系统设置」。
//
// **测试通过 =**（一句话）
// 「管理后台那排页签：**当前身份不是管理员 ⇒ 不画**；**即便管理员**，在**业务受管表页**
//   （URL 带 `?application=`）**也不画** —— 那一支是业务表页，不是管理后台；
//   而管理后台自己那几页（管理后台／账号管理／AI 工具／导航设置／系统设置）**照旧画**，
//   **不许把管理员的路也堵了**。」
//
// ⚠ **断的是行为，不是源码长相**：把公共壳里那函数**抠出来在沙箱里真跑一遍**
//   （假 document／假 location／假身份）⇒ 身份换了、URL 换了，看它到底画没画。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const APP = new URL('../app.js', import.meta.url);

/** 把 `window.xxx = (...) => {...};` 那一段抠出来（按大括号配平，末尾的 `;` 不要）。 */
function extractAssignment(source, name) {
  const marker = 'window.' + name + ' =';
  const start = source.indexOf(marker);
  assert.ok(start >= 0, 'app.js 里找不到 window.' + name + ' 的定义');
  const bodyStart = source.indexOf('{', start);
  assert.ok(bodyStart > start, 'window.' + name + ' 不是函数体');
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('window.' + name + ' 的大括号没配平');
}

/**
 * 在沙箱里真跑一次那函数。
 * @param role     当前身份（'admin' / 'staff' / 'manager' …）
 * @param search   URL 的查询串（例如 '?application=com.shangshu.finance.funding'）
 * @returns {{drawn:boolean, removed:boolean, html:string|null}}
 */
function renderAdminDestinations(role, search) {
  const source = fs.readFileSync(APP, 'utf8');
  const code = extractAssignment(source, 'shangshuRenderAdminDestinations');
  const holder = {
    removed: false,
    html: null,
    remove() { this.removed = true; },
    set outerHTML(value) { this.html = value; },
    get outerHTML() { return this.html; },
  };
  const host = {
    querySelector(selector) { return selector === '[data-admin-destinations]' ? holder : null; },
    querySelectorAll() { return []; },
  };
  const win = {
    shangshuAdminDestinations: (current) =>
      '<nav class="admin-destinations">' + String(current) + '</nav>',
    shangshuBindAdminDestinations() { win.bound = true; },
  };
  const doc = { querySelector: () => holder, querySelectorAll: () => [] };
  const location = { search: search || '', href: 'http://127.0.0.1:3850/index.html' + (search || ''), pathname: '/index.html' };
  /* 身份两种写法都给（`currentRole()` 与 `currentUserInfo?.role`）——
     不管实现用哪一个，测的仍是「身份换了，画没画」。 */
  const factory = new Function(
    'window', 'document', 'location', 'currentRole', 'currentUserInfo',
    code + '\nreturn window.shangshuRenderAdminDestinations;');
  const render = factory(win, doc, location, () => role, { username: 'u', role, display_name: 'U' });
  render(host, 'objects');
  return { drawn: typeof holder.html === 'string' && holder.html.length > 0, removed: holder.removed, html: holder.html };
}

test('① **普通员工看不到那排管理页签**（管理后台是管理员的地方）', () => {
  const result = renderAdminDestinations('staff', '');
  assert.equal(result.drawn, false,
    '普通员工在业务页上照样被画出了「管理后台／账号管理／系统设置」那一排 —— '
    + '管理后台的页签条只该给管理员看');
});

test('② **管理员在管理后台自己那几页上照旧看得见**（不许把管理员的路也堵了）', () => {
  const result = renderAdminDestinations('admin', '');
  assert.equal(result.drawn, true,
    '管理员进管理后台时那排页签没了 —— 页签条是管理后台的页面切换条，堵了管理员就换不了页');
  assert.match(String(result.html), /admin-destinations/,
    '画出来的那排不像管理页签条：' + result.html);
});

test('③ **业务受管表页不画那排页签**（那一支是业务表页，不是管理后台）', () => {
  /* 业务受管表页的地址：带 `?application=`（域把受管表挂上来时就是这么进的）。 */
  const result = renderAdminDestinations('admin', '?application=com.shangshu.finance.funding&dataset=finance.funding_request');
  assert.equal(result.drawn, false,
    '在业务受管表页上那排管理页签还在 —— 业务表页上凭空多出一排管理后台的页签，'
    + '用户看着莫名其妙（2026-10-24 22:2x 站上反馈）');
});

test('④ 管理员**不带应用参数**进跨应用数据目录时，那排页签照旧在', () => {
  const result = renderAdminDestinations('admin', '?dataset=finance.funding_request');
  assert.equal(result.drawn, true,
    '管理员进跨应用数据目录时那排页签没了（只有带 `?application=` 的业务表页才该没有）');
});
