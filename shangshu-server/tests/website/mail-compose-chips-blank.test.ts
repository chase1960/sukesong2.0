import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {installToast} from '../helpers/toast.ts';

/*
 FIX-24 收件人/抄送栏右边那大片空白 —— 2026-10-20 @browser-use 走查发现：

  写信窗里「收件人」那一栏，右边伸出去一大片**点不动的空白**：
  活站量：栏宽 765px，但可点的那颗「+」+ 说明只占左边 ~130px，
  剩下 600 多像素是**点下去毫无反应**的死区（实测点最右边 → 不开填写位）。
  用户看见一整条横线一样的空栏，会以为「点这行就能输入」——
  点了没反应，就以为这栏坏了。

  这一栏**本来就该是个能点开输入的位置**：收件人栏是整块输入区，
  点栏里的**任何空白**都该开出填写位（跟点那颗「+」一样），
  而不是只有那颗 28px 小圆钮算入口 —— 这也是 FIX-21 补的说明文字
  「点「+」加收件人」背后的真实痛点。

  测试通过 = 下面全部成立：
  1. 点收件人栏里那颗「+」**右边的空白**，会开出填写位（现在不开）。
  2. 抄送栏同样。
  3. 点「+」**照旧**在它左边开填写位（用户 2026-10-11 定的交互，一个字没改）。
  4. 点到**胶囊**或**填写位**本身，不许被当成"点空白"（不许误伤既有交互）。
  5. 填写位仍然开在**那颗「+」的左边**（不是右边、不是别处）。

  说明文字「点「+」加收件人」的口径也要跟上：既然点空白也能开，
  那句说明得改成**覆盖整栏**的说法 —— 钉的是「说得清、别只说那颗加号」。
*/

const tick = () => new Promise(r => setTimeout(r, 20));

function mount(rows: any[] = []) {
  const dom = new JSDOM('<div id="host"></div>', {url: 'http://localhost/index.html#/mail', runScripts: 'outside-only'});
  const w = dom.window as any;
  w.RENDER = {};
  w.currentRole = () => 'admin';
  w.fetch = async (url: string, options: any = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    if (url.includes('/services/mail.account.status/')) {
      return {ok: true, status: 200, json: async () => ({result: {account: {
        bound: true, enabled: true, connection_status: 'connected',
        email: 'me@qq.com', display_name: '我',
      }}})};
    }
    if (url.includes('/actions/mail.save_draft/execute')) {
      return {ok: true, status: 200,
        json: async () => ({result: {name: 'm-1', record_version: 1, attachments: [], attachment_bindings: {}}}),
        text: async () => '{}'};
    }
    if (url.includes('/datasets/')) {
      const payload = {rows, total: rows.length};
      return {ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload)};
    }
    const empty = {result: {}};
    return {ok: true, status: 200, json: async () => empty, text: async () => JSON.stringify(empty)};
  };
  installToast(w);
  for (const rel of ['tool-workspace.js', 'file-reference-picker.js', 'chip-input.js', 'domains/mail/mail-editor.js', 'mail-center.js']) {
    w.eval(readFileSync(new URL(`../../../shangshu-web/js/${rel}`, import.meta.url), 'utf8'));
  }
  const dispose = w.mountMailCenter(w.document.querySelector('#host'), {});
  return {w, dispose: () => { dispose(); dom.window.close(); }, doc: () => w.document};
}

async function openCompose(t: ReturnType<typeof mount>) {
  await tick(); await tick();
  (t.doc().querySelector('#compose') as any).click();
  await tick(); await tick();
}

function chipsHost(t: ReturnType<typeof mount>, id: string): any {
  const el = t.doc().querySelector(id);
  assert.ok(el, `写信窗里找不到 ${id}`);
  return el;
}

const slotOpen = (t: ReturnType<typeof mount>, id: string) => !!chipsHost(t, id).querySelector('[data-chip-field]');

/* 在胶囊栏里点一个「空白」位置 —— 落在那颗「+」**右边**，
   也就是用户看见却点不动的那一大片。 */
function clickBlankRightOfAdd(t: ReturnType<typeof mount>, id: string) {
  const host = chipsHost(t, id);
  const add = host.querySelector('[data-chip-add]') as any;
  assert.ok(add, '胶囊栏缺「+」按钮');
  /* 真实点击落在「+」右侧的空白上：这里用宿主元素自身当落点
     （胶囊组件把自己的「+」放在最右，说明文字在它右边 ——
     所以「+ 右边」这一段属于**栏容器自己**，不是组件内部）。
     判据钉的是「点了栏里的空白要开填写位」，不钉鼠标坐标。 */
  const blank = host.querySelector('[data-chip-hint]');
  assert.ok(blank, '前置：胶囊栏里该有那句看得见的说明');
  blank.dispatchEvent(new t.w.MouseEvent('click', {bubbles: true}));
}

it('点收件人栏里那颗「+」右边的空白，会开出填写位', async () => {
  const t = mount([{id: 'm-1', box: 'draft', subject: '测试', body: 'x', to: [], cc: [], attachments: []}]);
  try {
    await openCompose(t);
    const host = chipsHost(t, '#c-to-chips');
    assert.equal(slotOpen(t, '#c-to-chips'), false, '前置：还没开填写位');
    clickBlankRightOfAdd(t, '#c-to-chips');
    await tick();
    assert.ok(slotOpen(t, '#c-to-chips'),
      '点收件人栏里的空白，开不出填写位 —— 那一大片（活站量 600 多 px）点下去毫无反应，'
      + '用户只会以为这栏坏了');
    assert.ok(host, '前置');
  } finally { t.dispose(); }
});

it('抄送栏的空白同样能开出填写位', async () => {
  const t = mount([{id: 'm-1', box: 'draft', subject: '测试', body: 'x', to: [], cc: [], attachments: []}]);
  try {
    await openCompose(t);
    clickBlankRightOfAdd(t, '#c-cc-chips');
    await tick();
    assert.ok(slotOpen(t, '#c-cc-chips'), '抄送栏的空白点下去没反应');
  } finally { t.dispose(); }
});

it('点那颗「+」照旧在它左边开填写位（用户 2026-10-11 定的交互，一个字没改）', async () => {
  const t = mount([{id: 'm-1', box: 'draft', subject: '测试', body: 'x', to: [], cc: [], attachments: []}]);
  try {
    await openCompose(t);
    const host = chipsHost(t, '#c-to-chips');
    (host.querySelector('[data-chip-add]') as any).click();
    await tick();
    const slot = host.querySelector('[data-chip-field]') as any;
    assert.ok(slot, '点「+」没开出填写位');
    /* 填写位在「+」的**左边** —— 组件把填写位插在胶囊区末尾、「+」之前。 */
    const add = host.querySelector('[data-chip-add]') as any;
    const children = [...host.querySelector('.chip-input').children];
    assert.ok(children.indexOf(slot) < children.indexOf(add),
      '填写位跑到「+」的右边去了 —— 用户 2026-10-11 定的交互被改了');
  } finally { t.dispose(); }
});

it('点到胶囊或填写位本身，不许被当成「点空白」（不许误伤既有交互）', async () => {
  const t = mount([{id: 'm-1', box: 'draft', subject: '测试', body: 'x', to: [], cc: [], attachments: []}]);
  try {
    await openCompose(t);
    const host = chipsHost(t, '#c-to-chips');
    (host.querySelector('[data-chip-add]') as any).click();
    await tick();
    const slot = host.querySelector('[data-chip-field]') as any;
    assert.ok(slot, '前置：填写位该开着');
    /* 点填写位本身：不能把它关掉（那等于误伤打字）。 */
    slot.dispatchEvent(new t.w.MouseEvent('click', {bubbles: true}));
    await tick();
    assert.ok(host.querySelector('[data-chip-field]'),
      '点填写位本身把填写位关掉了 —— 正在打字的人会丢字');
  } finally { t.dispose(); }
});

it('说明文字得覆盖「点整栏都行」，别只说那颗加号', async () => {
  const t = mount([{id: 'm-1', box: 'draft', subject: '测试', body: 'x', to: [], cc: [], attachments: []}]);
  try {
    await openCompose(t);
    const hint = chipsHost(t, '#c-to-chips').querySelector('[data-chip-hint]') as any;
    assert.ok(hint, '前置：收件人栏该有那句看得见的说明');
    const text = (hint.textContent || '').trim();
    assert.ok(text.length >= 4, `说明太短，等于没说明：${JSON.stringify(text)}`);
    /* 口径检查：说明不许只把话头指向那颗小加号
       （现在点空白也能开填写位了，只说「点「+」」会让人以为只有那颗钮能点）。 */
    assert.doesNotMatch(text, /点[「"']?\+[」"']?加/,
      `说明仍然只提那颗「+」，可现在点空白也能开填写位 —— 口径与实际不符：${JSON.stringify(text)}`);
  } finally { t.dispose(); }
});
