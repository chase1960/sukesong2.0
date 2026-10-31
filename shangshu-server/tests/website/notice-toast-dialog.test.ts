import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

/*
 2026-10-12 用户当场指出的两个毛病：

  「notice 是有一个独立的公共组件的，不在这里!!!!」
  「notice 理论上在右下角时有一个公共组件的，你看看有没有？」
  「你的那个保存/退出弹窗没有加 div 和 padding，导致很丑」
  「把你的劣等品全部(不止刚刚提到的)改成 toast，然后再把弹窗修复好」
  「这个弹窗也抽象成公共组件」

 查实：产品早有右下角 toast 公共件（index.html 的 .toast-zone + app.js 的 toast()）。
 我没找到它，自造了一套并行的 #notice（底边居中、无动画），还每个页面各贴一份元素。
 弹窗那边我也没按产品的标准写法（native dialog + header/main/footer），所以缺 padding、丑。

 测试通过 = 下面全部成立：

  A. 提示走**右下角那个真 toast 公共件**；#notice 这套劣等品彻底不存在
     （元素、样式、代码三处都没有）。
  B. 页面模板里不再各贴一份提示元素。
  C. 收件人报错、邮箱设置报错都走 toast。
  D. 弹窗是**公共组件**：保存/退出那个窗走统一入口，结构是 header/main/footer（有内边距），
     不再是裸 h3+p 挤成一坨。
*/

const tick = () => new Promise(r => setTimeout(r, 20));
const settle = () => new Promise(r => setTimeout(r, 320));

const WEB = (rel: string) => new URL(`../../../shangshu-web/${rel}`, import.meta.url);

function mount(withCompose = true) {
  const dom = new JSDOM('<div id="host"></div><div id="toast-zone"></div>',
      {url: 'http://localhost/index.html#/mail', runScripts: 'outside-only'});
  const w = dom.window as any;
  w.RENDER = {}; w.currentRole = () => 'admin';
  const saves: any[] = [];
  w.fetch = async (url: string, options: any = {}) => {
    if (url.includes('mail.account.status')) return {ok: true, status: 200, json: async () => ({result: {account: {
      bound: true, enabled: true, connection_status: 'connected', email: 'me@qq.com', display_name: '我'}}})};
    if (url.includes('/datasets/')) {
      const rows = withCompose ? [{name: 'm1', subject: '样本', body: '<p>x</p>', body_format: 'HTML',
        to: [], cc: [], status: 'Draft', record_version: 1, owner: 'me@qq.com', modified: '2026-10-11 10:00:00',
        attachments: [], attachment_bindings: {}}] : [];
      const payload = {rows, total: rows.length};
      return {ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload)};
    }
    if (url.includes('mail.save_draft')) { saves.push(options.body ? JSON.parse(options.body) : {});
      const r = {name: 'm1', record_version: 1, attachments: [], attachment_bindings: {}};
      return {ok: true, status: 200, json: async () => ({result: r}), text: async () => JSON.stringify({result: r})}; }
    const empty = {result: {}};
    return {ok: true, status: 200, json: async () => empty, text: async () => JSON.stringify(empty)};
  };
  for (const rel of ['toast.js', 'tool-workspace.js', 'file-reference-picker.js', 'chip-input.js',
                     'domains/mail/mail-editor.js', 'mail-center.js']) {
    w.eval(readFileSync(WEB(`js/${rel}`), 'utf8'));
  }
  const dispose = w.mountMailCenter(w.document.querySelector('#host'), {});
  return {w, saves, doc: () => w.document, dispose: () => { dispose(); dom.window.close(); }};
}

async function openCompose(t: ReturnType<typeof mount>) {
  await tick(); await tick();
  // 直接点「写邮件」建新信 —— 和其它写信窗测试同一走法，不依赖种子数据
  const compose = t.doc().querySelector('#compose') as any;
  assert.ok(compose, '找不到写邮件按钮');
  compose.click();
  await tick(); await tick();
  const ed = t.doc().querySelector('.mail-body-editor') || t.doc().querySelector('#c-body');
  if (!ed) {
    throw new Error('写信窗没打开；现场=' + JSON.stringify({
      subject: !!t.doc().querySelector('#c-subject'),
      dialogs: t.doc().querySelectorAll('[role="dialog"], dialog').length,
      body: (t.doc().body.textContent || '').slice(0, 120),
    }));
  }
  return ed;
}

it('A 提示走右下角真 toast 公共件；#notice 劣等品三处都不该再有', () => {
  // 公共件本身要能用
  const dom = new JSDOM('<div id="toast-zone"></div>', {url: 'http://localhost/', runScripts: 'outside-only'});
  const w = dom.window as any;
  w.eval(readFileSync(WEB('js/toast.js'), 'utf8'));
  assert.equal(typeof w.toast, 'function', 'toast 公共件没有暴露成全局入口');
  w.toast('标题', '副标题', 'error');
  const toast = w.document.querySelector('#toast-zone .toast');
  assert.ok(toast, 'toast 公共件没把提示弹到右下角容器里');
  assert.equal(toast.querySelector('.toast-title')?.textContent, '标题');
  assert.equal(toast.querySelector('.tt')?.textContent, '副标题');
  assert.ok(toast.classList.contains('toast-error'), '错误提示没走错误样式');
  dom.window.close();

  // 劣等品必须绝迹：元素、样式、代码
  const js = ['js/tool-workspace.js', 'js/mail-center.js', 'js/sheet-center.js', 'js/domains/mail/mail-settings.js'];
  for (const rel of js) {
    const src = readFileSync(WEB(rel), 'utf8');
    assert.ok(!/id=["']notice["']/.test(src), `${rel} 还在页面模板里贴 #notice 元素（该由公共件创建）`);
    assert.ok(!/\$\(['"]#notice['"]\)|querySelector\(['"]#notice['"]\)/.test(src), `${rel} 还在直接操作 #notice`);
  }
  for (const rel of ['css/workbench.css', 'css/mail-center.css', 'css/sheet-center.css', 'css/file-center.css']) {
    const css = readFileSync(WEB(rel), 'utf8');
    assert.ok(!/(^|\n)\s*#notice\s*\{/.test(css), `${rel} 还留着 #notice 的样式（该用 .toast）`);
  }
});

it('B 页面模板里不再各贴一份提示元素', async () => {
  const t = mount();
  try {
    await tick();
    const n = t.doc().querySelector('#notice');
    assert.equal(n, null, '页面里还贴着 #notice 元素');
    // 公共容器要由公共件准备
    assert.ok(t.doc().querySelector('#toast-zone'), '没有右下角 toast 容器');
  } finally { t.dispose(); }
});

it('C 收件人报错走 toast，不走任何自造红字', async () => {
  const t = mount();
  try {
    const ed = await openCompose(t);
    const to = t.doc().querySelector('#c-to') as any;
    to.value = '12@q';
    to.dispatchEvent(new t.w.Event('input', {bubbles: true}));
    ed.blur?.();
    ed.dispatchEvent(new t.w.FocusEvent('blur', {bubbles: true}));
    await settle();

    const toast = t.doc().querySelector('#toast-zone .toast');
    assert.ok(toast, '收件人报错没走 toast 公共件');
    const text = toast.textContent || '';
    assert.ok(/无法识别的地址/.test(text), `toast 里没说清是地址问题：${text}`);
    assert.ok(/12@q/.test(text), `toast 里没说是哪个地址：${text}`);
    assert.ok(!/分号/.test(text), `还在叫人「分号隔开」：${text}`);
    /* 用户 2026-10-12 补充两条：
       ① 报错要**红**（错误色），不能是绿的成功色
       ② **只留「收件人……」这一句**，不要再拖「一次填一个人 / 点 + 加下一个人」那种说明书 */
    assert.ok(toast.classList.contains('toast-error'),
        `收件人报错没走错误色（红），现在是：${toast.className}`);
    assert.equal(toast.getAttribute('role'), 'alert', '错误提示该用 alert 语义');
    assert.ok(!/一次填一个人|点 \+|回车|加下一个人/.test(text),
        `报错里还拖着说明书，用户说只要「收件人……」这一句：${text}`);

    for (const sel of ['#e-to', '#e-cc', '#acc-error']) {
      const el = t.doc().querySelector(sel) as any;
      const shown = el && !el.hidden && (el.textContent || '').trim();
      assert.ok(!shown, `还在自造红字 ${sel}：${JSON.stringify(shown)}`);
    }
  } finally { t.dispose(); }
});

it('D 保存/退出弹窗走公共弹窗组件，结构是 header/main/footer（有内边距）', async () => {
  const t = mount();
  try {
    const ed = await openCompose(t);
    ed.innerHTML = '<p>改过的内容</p>';
    ed.dispatchEvent(new t.w.Event('input', {bubbles: true}));
    await tick();

    const closeBtn = t.doc().querySelector('#dlg-close') || t.doc().querySelector('#c-cancel') as any;
    closeBtn.click();
    await tick();

    const dlg = t.doc().querySelector('dialog, [role="dialog"]') as any;
    assert.ok(dlg, '点关闭没有弹出弹窗');
    // 公共组件的标志：统一入口造出来的标准结构
    assert.ok(dlg.querySelector('header'), `弹窗缺 header（所以标题贴着边）：${dlg.innerHTML.slice(0, 160)}`);
    assert.ok(dlg.querySelector('main'), `弹窗缺 main（所以正文没内边距）：${dlg.innerHTML.slice(0, 160)}`);
    assert.ok(dlg.querySelector('footer'), `弹窗缺 footer（所以按钮贴着边）：${dlg.innerHTML.slice(0, 160)}`);
    // 两个出口都得在
    const text = dlg.textContent || '';
    assert.ok(/继续编辑/.test(text), `弹窗没有「继续编辑」出口：${text}`);
    assert.ok(/放弃/.test(text), `弹窗没有「放弃」出口：${text}`);

    // 公共弹窗入口是公共壳上的能力，不是邮件页自己拼 HTML
    const uiSrc = readFileSync(WEB('js/tool-workspace.js'), 'utf8');
    assert.ok(/dialog\s*[:(=]/.test(uiSrc), '公共壳上没有弹窗组件入口');
  } finally { t.dispose(); }
});

/*
 2026-10-12 用户：「你看看你做的这一些和 excel 那边是不是耦合的…以及文件部分等其他部分，
 确保邮件部分是高内聚低耦合的」。

 查实两处**我自己引入**的耦合：
   ① 公共弹窗 ui.dialog 借用了**文件中心**的样式类 file-operation-dialog
      → 邮件因此依赖 file-center.css；文件那边改名/删样式，邮件弹窗就坏
   ② 公共壳 modal() 默认 prefix='mail' —— 公共层里混着邮件专属默认值

 测试通过 = 邮件的代码不依赖别的业务模块，弹窗有自己的公共样式。
*/

it('E 邮件不依赖别的业务模块：公共弹窗有自己的样式，不借用文件中心的', () => {
  /* 只看**代码**，不看注释 —— 注释里可以写「我们以前借用了 X，现在拆掉了」，
     那是留痕不是依赖。判的是活代码有没有引用别的业务模块的东西。 */
  const stripComments = (src: string) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  const ui = stripComments(readFileSync(WEB('js/tool-workspace.js'), 'utf8'));
  assert.ok(!/file-operation-dialog/.test(ui),
      '公共弹窗还在借用文件中心的样式类 file-operation-dialog —— 邮件会因此依赖 file-center.css');
  // 公共层不许有邮件专属的默认值
  assert.ok(!/prefix\s*=\s*['"]mail['"]/.test(ui),
      "公共壳 modal() 的默认 prefix 是 'mail'，公共层里混进了邮件专属默认值");

  // 邮件自己也不能伸手进别的业务模块
  for (const rel of ['js/mail-center.js', 'js/domains/mail/mail-editor.js', 'js/domains/mail/mail-settings.js']) {
    const src = stripComments(readFileSync(WEB(rel), 'utf8'));
    for (const foreign of ['file-operation-dialog', 'file-detail-dialog', 'sheet-overlay', 'sheet-center']) {
      assert.ok(!src.includes(foreign), `${rel} 引用了别的业务模块的东西：${foreign}`);
    }
  }

  // 公共弹窗的样式必须在**公共样式表**里（谁都加载的那份），不能藏在某个业务模块的 css 里
  const common = readFileSync(WEB('css/workbench.css'), 'utf8');
  assert.ok(/\.os-dialog/.test(common), '公共弹窗没有自己的样式类（该在 workbench.css 里）');
  assert.ok(/\.os-dialog[^{]*\{[^}]*padding/.test(common), '公共弹窗的样式里没有内边距');
});
