import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {Script} from 'node:vm';

/* admin 系统设置那几页的**版式**改版（只改版式，不改功能与流程）。

   这组判据要成立 =：
   1. admin 的几页（系统配置 / 导航设置 / 账号管理 / AI 工具）都挂上**同一个版式根类**
      `.admin-page` —— 一套版式，不是每页各写一套；
   2. 那一套版式**真的看得见边界**：分区是有边框的卡片（不是白底飘在白底上）、
      页头**与全站同一副骨架**（不再是管理员页单开的一套）、操作按钮**右对齐成一排**、
      说明文字用**次级色**、控件宽度**收敛**（分段按钮不再溢出到隔壁那一列）、
      空状态有一句人话；
   3. 版式**没动业务**：页面上原有的字段、按钮、口径一个不少、没多。

   **测试通过 =**（一句话）
   「admin 那几页共用一套 `.admin-page` 版式：分区卡片看得见边界、圆角**真的解析得出来**
     （公共令牌 `--r-lg` 有值）、页头挂公共骨架类 `.page-heading` 且**不再单开**一套规则、
     操作行右对齐、空状态有一句人话 —— 而页面上原有的字段／按钮／口径一个没少。」 */

const WEB = new URL('../../../shangshu-web/', import.meta.url);
const css = (rel: string) => readFileSync(new URL(rel, WEB), 'utf8');
const js = (rel: string) => readFileSync(new URL(rel, WEB), 'utf8');

const ADMIN_CSS = 'css/admin-pages.css';
const ADMIN_PAGES = [
  { file: 'js/real-config.js', label: '系统配置 / 导航设置' },
  { file: 'js/real-users.js', label: '账号管理' },
  { file: 'js/real-ai-tools.js', label: 'AI 工具' },
];

/** 取某条规则（选择器完全相等）的某个属性值。 */
function ruleValue(source: string, selText: string, prop: string): string | null {
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, '');
  let hit: string | null = null;
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    const parts = m[1].trim().split(',').map((s) => s.trim());
    if (!parts.includes(selText)) continue;
    for (const d of m[2].split(';')) {
      const i = d.indexOf(':');
      if (i < 0) continue;
      if (d.slice(0, i).trim().toLowerCase() === prop) hit = d.slice(i + 1).trim();
    }
  }
  return hit;
}

/**
 * 圆角值解析：字面量直接取 px；`var(--令牌)` 去**公共令牌表**里查它的值。
 * 查不到 ⇒ null（判据必须红）——「用了变量」不等于「圆角真的在」。
 */
function resolveRadius(value: string): number | null {
  const direct = parseFloat(value);
  if (Number.isFinite(direct)) return direct;
  const ref = value.match(/^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)$/);
  if (!ref) return null;
  const fallback = ref[2] ? parseFloat(ref[2]) : NaN;
  /* 公共令牌表在 css/deepseek.css（`--r-lg:8px` 等）—— 与产品用的是同一份。 */
  const hit = new RegExp(`${ref[1]}\\s*:\\s*([0-9.]+)px`).exec(css('css/deepseek.css'));
  if (hit) return parseFloat(hit[1]);
  return Number.isFinite(fallback) ? fallback : null;
}

it('admin 几页挂上同一个版式根类 .admin-page', () => {
  for (const page of ADMIN_PAGES) {
    const source = js(page.file);
    assert.match(source, /admin-page/,
      `${page.label}（${page.file}）没挂 .admin-page —— 几页还是各写各的版式`);
  }
});

it('admin 版式：分区是有边界的卡片，说明文字次级色，操作按钮右对齐成一排', () => {
  const source = css(ADMIN_CSS);
  const border = ruleValue(source, '.admin-page .card', 'border');
  assert.ok(border, 'admin 卡片没有边框规则 —— 白底飘在白底上，看着像没分区');
  assert.ok(!/none/.test(border!), `admin 卡片的边框是 ${border} —— 那就没有边界`);
  const radius = ruleValue(source, '.admin-page .card', 'border-radius');
  assert.ok(radius, 'admin 卡片没有圆角规则 —— 和主界面不是一个观感');
  /* ⚠️ **2026-10-22 起（提交 e92b0d29f「全站拉齐到参照系」）圆角改用公共令牌
     `var(--r-lg)`** —— 圆角**真的还在**（`--r-lg:8px` 定义在 css/deepseek.css），
     只是不再写死字面量 ⇒ 判据不许只认「字符串里有没有数字」，
     要**真的解析出**这个变量的值并断言它是**正数**（令牌没定义 ⇒ 圆角为 0 ⇒ 判据必须红）。 */
  const radiusPx = resolveRadius(radius!);
  assert.ok(radiusPx !== null && radiusPx > 0,
    `admin 卡片的圆角是 ${radius} —— 解析不出一个正的圆角（令牌没定义？那圆角就是 0）`);
  const actions = ruleValue(source, '.admin-page .admin-actions', 'justify-content');
  assert.equal(actions, 'flex-end',
    `admin 操作行没右对齐（justify-content=${actions}）—— 按钮还是散在左边`);
  const help = ruleValue(source, '.admin-page .cell-sub', 'color');
  assert.ok(help && /--fg3/.test(help),
    `admin 说明文字的颜色是 ${help} —— 该用次级色（--fg3），别跟正文抢眼`);
  const label = ruleValue(source, '.admin-page .fld label', 'display');
  assert.equal(label, 'block',
    `admin 字段标签的 display 是 ${label} —— 标签该在控件上方`);
});

it('admin 版式：分段按钮不再溢出到隔壁那一列，控件宽度仍由全局上限管着', () => {
  const source = css(ADMIN_CSS);
  const seg = ruleValue(source, '.admin-page .fld .seg', 'max-width');
  assert.equal(seg, '100%',
    `分段按钮（provider 那一排）的 max-width 是 ${seg} —— 它会溢出到右边那一列的输入框上`
    + '（活站量：「qwen-ocr」压住了「ocr-service 地址」那个输入框）');
  /* 控件宽度**不在 admin 版式里再收一遍**：全局 FIX-50 已经封了 280px（通用）/380px（地址、密钥）。
     admin 版式若在这里再给一个上限，长地址会被截短 —— 那不叫「按内容收敛」。 */
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    const sel = m[1].trim();
    if (!/\.fld\s+(input|select|textarea)/.test(sel)) continue;
    assert.doesNotMatch(m[2], /(max-)?width\s*:/,
      `admin 版式给表单控件又加了一条宽度规则（${sel}）—— 宽度由全局 FIX-50 统一管，别在这里再收一遍`);
  }
});

it('admin 版式：页头与全站同一副骨架（不再单开一套），空状态有一句人话', () => {
  const source = css(ADMIN_CSS);
  /* ⚠️ **2026-10-22 起（提交 e92b0d29f「全站拉齐到参照系」）＋ 2026-10-23 起
     （提交 fd1a179f9 · 全站页头条收成同一副骨架 · PKG-045-T02）**：
     admin 版式**删掉**了 `.admin-page .page-hd:not(.platform-page-head)` 那条
     「标题与说明分两行」的单开规则（CSS 注释里明写：管理员页与别的页一样，
     标题／说明／按钮同一行）⇒ 原来这条「必须分两行」的断言**过期**。
     ⇒ 判据改成断**同一件事的现在版本**：页头**挂公共骨架类**（与全站同一副骨架）：
       ① admin 版式里**不许**再有那条单开规则（某页单开 ⇒ 全站页头条又变成好几种形态）；
       ② 三个 admin 页的页头条都挂 `.page-heading`（公共骨架类）。
     配套判据（算生效几何）：shangshu-web/js/tests/page-shell.test.mjs。 */
  assert.equal(ruleValue(source, '.admin-page .page-hd:not(.platform-page-head)', 'flex-direction'), null,
    'admin 版式又单开了一条页头规则 —— 全站页头条只有一副骨架，不许某页单开');
  for (const page of ADMIN_PAGES) {
    assert.match(js(page.file), /class="[^"]*\bpage-heading\b[^"]*"/,
      `${page.label}（${page.file}）的页头条没挂公共骨架类 .page-heading —— 与全站不是同一副骨架`);
  }
  assert.match(source, /\.admin-empty/,
    'admin 版式里没有空状态 —— 列表空着的时候屏幕上什么都没有，用户不知道是坏了还是没数据');
});

it('admin 版式样式表被入口页加载（不然改了也不生效）', () => {
  const index = js('index.html');
  assert.match(index, /css\/admin-pages\.css/,
    'index.html 没引 admin-pages.css —— 版式改了也不生效');
});

/* —— 真渲染一次：导航设置那页（同步渲染，不取数）—— */
function renderModulesPage() {
  const dom = new JSDOM('<div id="main"><div class="main-scroll"></div></div>', { url: 'http://localhost/#/modules', runScripts: 'outside-only' });
  const w = dom.window as any;
  /* RENDER 在 app.js 里是 `const`（全局词法绑定）—— 只挂 window.RENDER 的话，
     被 eval 的页面脚本看不到它（跟生产同一口径：词法路由表，不是 window 挂件）。 */
  new Script('const RENDER = {}; window.RENDER = RENDER;').runInContext(dom.getInternalVMContext());
  w.$ = (s: string) => w.document.querySelector(s);
  w.$$ = (s: string) => [...w.document.querySelectorAll(s)];
  w.esc = (v: any) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as any)[c]);
  w.ICONS = { grip: '<svg></svg>' };
  w.mainBox = () => w.document.querySelector('.main-scroll');
  w.moduleCatalog = () => [{ sec: '工作', items: [{ id: 'dash', name: '工作台', ico: 'home', on: true, preset: true, real: true }] }];
  w.sidebarEditorGroups = () => [{ sec: '工作', items: ['dash'] }];
  w.sidebarLibraryModules = () => [];
  w.isSidebarModLocked = () => true;
  w.CORE_ITEMS = [];
  w.canSee = () => true;
  w.findWorkspaceItem = (id: string) => ({ id, name: '工作台', ico: 'home' });
  w.eval(js('js/real-config.js'));
  w.RENDER['modules']();
  return w;
}
it('导航设置那页真渲染出来是有分区的卡片，不是散着的文字', () => {
  const w = renderModulesPage();
  const page = w.document.querySelector('.main-scroll');
  assert.ok(page, '页面没画出来');
  assert.ok(page.querySelector('.admin-page'), '导航设置那页没挂 .admin-page');
  assert.ok(page.querySelector('.admin-page .page-hd h1'), '导航设置那页没有标题');
  assert.ok(page.querySelector('.admin-page .card'), '导航设置那页没有分区卡片');
  /* 版式只管排版：原有的分区标题与说明一个字不许少。 */
  const text = page.textContent || '';
  assert.match(text, /模块开关/, '「模块开关」这个分区不见了');
  assert.match(text, /侧栏布局/, '「侧栏布局」这个分区不见了');
});
